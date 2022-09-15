"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Bluebird = require("bluebird");
const Dockerode = require("dockerode");
const duplexify = require("duplexify");
const es = require("event-stream");
const JSONStream = require("JSONStream");
const _ = require("lodash");
const fs = require("mz/fs");
const path = require("path");
const tar = require("tar-stream");
const Utils = require("./utils");
const emptyHandler = () => undefined;
class Builder {
    constructor(docker) {
        this.docker = docker;
    }
    static fromDockerode(docker) {
        return new Builder(docker);
    }
    static fromDockerOpts(dockerOpts) {
        return new Builder(new Dockerode(_.merge(dockerOpts, { Promise: Bluebird })));
    }
    createBuildStream(buildOpts, hooks = {}, handler = emptyHandler) {
        const layers = [];
        const fromTags = [];
        const inputStream = es.through();
        const dup = duplexify();
        dup.setWritable(inputStream);
        let streamError;
        const failBuild = _.once((err) => {
            streamError = err;
            dup.destroy(err);
            return this.callHook(hooks, 'buildFailure', handler, err, layers, fromTags);
        });
        inputStream.on('error', failBuild);
        dup.on('error', failBuild);
        const buildPromise = Bluebird.try(() => this.docker.buildImage(inputStream, buildOpts)).then((daemonStream) => {
            return new Bluebird((resolve, reject) => {
                const outputStream = getDockerDaemonBuildOutputParserStream(daemonStream, layers, fromTags, reject);
                outputStream.on('error', (error) => {
                    daemonStream.unpipe();
                    reject(error);
                });
                outputStream.on('end', () => streamError ? reject(streamError) : resolve());
                dup.setReadable(outputStream);
            });
        });
        Bluebird.all([
            buildPromise,
            this.callHook(hooks, 'buildStream', handler, dup),
        ])
            .then(() => {
            if (!streamError) {
                return this.callHook(hooks, 'buildSuccess', handler, _.last(layers), layers, fromTags);
            }
        })
            .catch(failBuild);
        return dup;
    }
    buildDir(dirPath, buildOpts, hooks, handler = emptyHandler) {
        const pack = tar.pack();
        return Utils.directoryToFiles(dirPath)
            .map((file) => {
            const relPath = path.relative(path.resolve(dirPath), file);
            return Bluebird.all([relPath, fs.stat(file), fs.readFile(file)]);
        })
            .map((fileInfo) => {
            return Bluebird.fromCallback((callback) => pack.entry({ name: fileInfo[0], size: fileInfo[1].size }, fileInfo[2], callback));
        })
            .then(() => {
            pack.finalize();
            const stream = this.createBuildStream(buildOpts, hooks, handler);
            pack.pipe(stream);
            return stream;
        });
    }
    callHook(hooks, hook, handler, ...args) {
        return Bluebird.try(() => {
            const fn = hooks[hook];
            if (_.isFunction(fn)) {
                return fn.apply(null, args);
            }
        }).tapCatch((error) => {
            if (_.isFunction(handler)) {
                handler(error);
            }
        });
    }
}
exports.default = Builder;
function getDockerDaemonBuildOutputParserStream(daemonStream, layers, fromImageTags, onError) {
    const fromAliases = new Set();
    return (daemonStream
        .pipe(JSONStream.parse())
        .pipe(es.through(function (data) {
        if (data == null) {
            return;
        }
        try {
            if (data.error) {
                throw new Error(data.error);
            }
            else {
                const sha = Utils.extractLayer(data.stream);
                if (sha !== undefined) {
                    layers.push(sha);
                }
                const fromTag = Utils.extractFromTag(data.stream);
                if (fromTag !== undefined) {
                    if (!fromAliases.has(fromTag.repo)) {
                        fromImageTags.push(fromTag);
                    }
                    if (fromTag.alias) {
                        fromAliases.add(fromTag.alias);
                    }
                }
                this.emit('data', data.stream);
            }
        }
        catch (error) {
            daemonStream.unpipe();
            onError(error);
        }
    })));
}
//# sourceMappingURL=builder.js.map
