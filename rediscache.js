const pathToRegExp = require('path-to-regexp')
const crypto = require('crypto')

module.exports = function(Model, options) {
    var redisSettings = {cache: 300}; // default cache timeout 5 mins

    if(options.client){
        var clientSettings = options.client;
    }else{
        var app = require('../../server/server.js');
        redisSettings = Object.assign(redisSettings, app.get('redis'));
        var clientSettings = redisSettings.client;
        var models = redisSettings.models; 
    }

    if (clientSettings.disable === 'false') {
        console.log('Enable Redis for: ', Model.name);
        var redis = require("redis"),
            client = redis.createClient(clientSettings);

        var redisDeletePattern = require('redis-delete-pattern');
        let route

        client.on("error", function (err) {
            console.log(err);
            // try to connect again with server config
            if(err.toString().indexOf("invalid password") !== -1){
                console.log("Invalid password... reconnecting with server config...");
                var app = require('../../server/server');
                var clientSettings = app.get('redis');        
                client = redis.createClient(clientSettings);
            }
        });

        Model.beforeRemote('**', function(ctx, res, next) {
            let path = ctx.req.baseUrl + ctx.req.path;
            // get all find methods and search first in cache
            route = routeMatch(redisSettings.routes, path);
            if((ctx.method.name.indexOf("find") !== -1 || ctx.method.name.indexOf("__get") !== -1 || ctx.req.method.indexOf("GET") !== -1) && client.connected){
                if(typeof ctx.req.query.cache != 'undefined' || route){
                    var modelName = ctx.method.sharedClass.name;

                    // set key name
                    var request_key = JSON.stringify(Object.assign(ctx.req.query, {path, access_token:''})).toString();
                    let relatedModel = '';  // add to cache key
                    let pathRelatedModel = ''; // add to cache key

                    // Get related model from filter
                    // TODO: this only checks for single string in filter include
                    if (ctx.req.query.filter && typeof ctx.req.query.filter === 'string') {
                        let filter = JSON.parse(ctx.req.query.filter)
                        if (filter.include && typeof filter.include === 'string') {
                            let include = filter.include
                            for (let model of models) {
                                if (include.indexOf(model) > -1) {
                                    relatedModel = model;
                                }
                            }
                        }
                    }
                    // Get related model from path
                    for (let model of models) {
                        if (path.indexOf(model) > -1) {
                            pathRelatedModel = model
                        }
                    }

                    request_key = crypto.createHash('md5').update(request_key).digest("hex");
                    var cache_key = modelName.toLowerCase() + pathRelatedModel + relatedModel + request_key;

                    // search for cache
                    client.get(cache_key, function(err, val) {
                        if(err){
                            console.log(err);
                        }

                        if(val !== null){
                            ctx.result = JSON.parse(val);
                            ctx.res.set('X-Cache', true);
                            ctx.done(function(err) {
                                if (err) return next(err);
                            });
                        }else{
                            //return data
                            next();
                        }                
                    });    

                }else{
                    next();
                }
            }else{
                next();
            }            
        });    

        Model.afterRemote('**', function(ctx, res, next) {
            let path = ctx.req.baseUrl + ctx.req.path;
            // get all find methods and search first in cache - if not exist save in cache
            if((ctx.method.name.indexOf("find") !== -1 || ctx.method.name.indexOf("__get") !== -1 || ctx.req.method.indexOf("GET") !== -1) && client.connected){
                if(typeof ctx.req.query.cache != 'undefined' || route){
                    var modelName = ctx.method.sharedClass.name;
                    var cachExpire = ctx.req.query.cache || route.expire || redisSettings.cache;;
                    
                    // set key name
                    var request_key = JSON.stringify(Object.assign(ctx.req.query, {path, access_token:''})).toString();
                    let relatedModel = '';
                    let pathRelatedModel = '';

                    // Get related model from filter
                    // TODO: this only checks for single string in filter include
                    if (ctx.req.query.filter && typeof ctx.req.query.filter === 'string') {
                        let filter = JSON.parse(ctx.req.query.filter)
                        if (filter.include && typeof filter.include === 'string') {
                            let include = filter.include
                            for (let model of models) {
                                if (include.indexOf(model) > -1) {
                                    relatedModel = model;
                                }
                            }
                        }
                    }
                    // Get related model from path
                    for (let model of models) {
                        if (path.indexOf(model) > -1) {
                            pathRelatedModel = model
                        }
                    }
                    request_key = crypto.createHash('md5').update(request_key).digest("hex");
                    var cache_key = modelName.toLowerCase() + pathRelatedModel + relatedModel + request_key;
                    // search for cache
                    client.get(cache_key, function(err, val) {

                        if(err){
                            console.log(err);
                        }

                        if(val == null){
                            // set cache key
                            client.set(cache_key, JSON.stringify(res));
                            client.expire(cache_key, cachExpire);
                            next();
                        }else{
                            next();
                        }               
                    });    

                }else{
                    next();
                }
            }else{
                next();
            }        
        });

        Model.afterRemote('**', function(ctx, res, next) {
            // delete cache on patchOrCreate, create, delete, update, destroy, upsert
            if((ctx.method.name.indexOf("find") == -1 && ctx.method.name.indexOf("__get") == -1 && ctx.req.method.indexOf("GET") == -1) && client.connected){
                if(typeof ctx.req.query.cache != 'undefined' || route){
                    var modelName = ctx.method.sharedClass.name;
                    
                    // set key name
                    var cache_key = '*' + modelName.toLowerCase()+'*';
                    var relatedModel = null;
                    var path = ctx.req.path;

                    for (let model of models) {
                        if (path.includes(model)) {
                            relatedModel = model;
                            break;
                        }
                    }

                    // delete cache
                    redisDeletePattern({
                        redis: client,
                        pattern: cache_key
                    }, function handleError (err) {
                        if(err){
                            console.log(err);
                        }

                        // Delete related model cache
                        if (relatedModel != null) {
                            redisDeletePattern({
                                redis: client,
                                pattern: '*' + relatedModel.toLowerCase()+'*'
                            }, function handleError (err) {
                                if (err) {
                                    console.log(err);
                                }
                            })
                        }
                        next();
                    });
                } else {
                    next();
                }
            }else{
                next();
            }    
        });
    }

    // Follows route pattern: https://github.com/coderhaoxin/koa-redis-cache.git
    function routeMatch(routes, path) {
        for (let i = 0; i < routes.length; i++) {
            let route = routes[i]
      
            if (paired(route.path, path)) {
              match = true
              return route
              break
            }
          }
          return null
    }

    // return true if path match
    function paired(route, path) {
        let options = {
          sensitive: false,
          strict: false,
        }
      
        return pathToRegExp(route, [], options).exec(path)
      }
}