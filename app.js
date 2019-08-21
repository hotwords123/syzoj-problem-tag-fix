
'use strict';

const fs    = require('fs');
const http  = require('http');
const https = require('https');

const FileCache = require('./file-cache.js');

const {
    source_site, dest_site, timeout: request_timeout, id_ranges
} = require('./config.json');
const dest_tags = JSON.parse(fs.readFileSync('./dest-tags.json'));
const tag_alias = fs.readFileSync('./tag-alias.txt').toString();

class CrawlError extends Error {
    constructor(...arg) {
        super(...arg);
    }
}

async function getResponse(req) {
    return new Promise((resolve, reject) => {
        req.on('error', reject);
        req.on('timeout', () => {
            reject(new CrawlError("request timeout"));
            req.destroy();
        });
        req.on('response', (res) => {
            if (res.statusCode !== 200) {
                reject(new CrawlError("HTTP " + res.statusCode));
                return;
            }
            let result = '';
            res.on('data', (chunk) => {
                result += chunk;
            });
            res.on('end', () => {
                resolve(result);
            });
        });
    });
}

function getWebFor(host) {
    if (host.startsWith('http:')) return http;
    if (host.startsWith('https:')) return https;
    throw new CrawlError("unknown protocol");
}

async function getProblemInfo(site, pid) {
    let web = getWebFor(site.host);
    let result = await getResponse(web.get(site.host + '/problem/' + pid + '/export', {
        headers: site.headers,
        timeout: request_timeout
    }));
    let data = JSON.parse(result);
    if (!data.success) throw new CrawlError(`problem ${pid} not found at ${site.host}`);
    return data.obj;
}

function compareNames(a, b) {
    a = a.replace(/\s/g, '').toLowerCase();
    b = b.replace(/\s/g, '').toLowerCase();
    return a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
}

async function searchProblem(site, title) {
    let web = getWebFor(site.host);
    let result = await getResponse(web.get(site.host + '/api/v2/search/problems/' + encodeURIComponent(title), {
        headers: site.headers,
        timeout: request_timeout
    }));
    let data = JSON.parse(result);
    if (!data.success) throw new CrawlError("problem search failed");
    for (let {name, value} of data.results) {
        let actualName = name.slice(name.indexOf('.') + 2);
        if (compareNames(title, actualName)) return parseInt(value);
    }
    throw new CrawlError(`problem ${title} not found at ${site.host}`);
}

async function withCache(cache, fn, site, key, save = false) {
    if (cache.has(key)) return cache.get(key);
    let value = await fn(site, key);
    if (value) {
        cache.set(key, value);
        if (save) cache.save();
    }
    return value;
}

let logs = [];
function log(a) {
    let str = '[' + new Date().toLocaleTimeString() + '] ';
    if (a instanceof Error) {
        if (a instanceof CrawlError) {
            str += a.message;
        } else {
            str += a.stack;
        }
    } else {
        str += a.toString();
    }
    console.log(str);
    logs.push(str);
}
function saveLogs() {
    fs.writeFileSync('./logs-' + Date.now() + '.txt', logs.join('\n'));
}

(async () => {

    let tagMap = new Map();
    let tagAliasMap = new Map();
    let tagAliasRE = [];
    for (let {id, name} of dest_tags) {
        tagMap.set(name, id);
    }
    tag_alias.split('\n').forEach(str => {
        if (str.trimLeft().startsWith('#')) return;
        let [source, dest] = str.split('=');
        if (!dest) return;
        source = source.trim();
        dest = dest.trim();
        if (!source || !dest) return;
        if (source.startsWith('/') && source.endsWith('/')) {
            tagAliasRE.push({
                regex: new RegExp(source.slice(1, -1), 'i'),
                dest: dest
            });
        } else {
            tagAliasMap.set(source, dest);
        }
    });

    function resolveAlias(name) {
        if (tagAliasMap.has(name)) return tagAliasMap.get(name);
        let item = tagAliasRE.find(({regex}) => regex.test(name));
        if (item) return item.dest;
        return name;
    }

    let cacheSource = new FileCache('./cache-source.json');
    let cacheSearch = new FileCache('./cache-search.json');
    let cacheDest = new FileCache('./cache-dest.json');

    let saveCaches = () => {
        log('saving cache');
        cacheSource.save();
        cacheSearch.save();
        cacheDest.save();
    };

    process.on('SIGINT', () => {
        saveCaches();
        log('process exiting');
        saveLogs();
        process.exit(0);
    });

    let tagsMissing = new Set();
    let tagsToAdd = [];
    for (let [id_min, id_max] of id_ranges) {
        for (let pid = id_min; pid <= id_max; ++pid) {
            try {
                let info = await withCache(cacheDest, getProblemInfo, dest_site, pid);
                let pid2 = await withCache(cacheSearch, searchProblem, source_site, info.title);
                let info2 = await withCache(cacheSource, getProblemInfo, source_site, pid2);
                log(`#${pid}. ${info.title} => #${pid2}. ${info2.title}`);
                for (let tagName of info2.tags) {
                    tagName = resolveAlias(tagName);
                    if (tagMap.has(tagName)) {
                        if (info.tags.includes(tagName)) {
                            log(`tag ${tagName} already exists`);
                        } else {
                            tagsToAdd.push({
                                problem_id: pid,
                                tag_id: tagMap.get(tagName)
                            });
                        }
                    } else {
                        tagsMissing.add(tagName);
                        log(`tag ${tagName} not found in tag list`);
                    }
                }
            } catch (err) {
                log(err);
            }
        }
    }

    saveCaches();

    let sql = tagsToAdd.map(({problem_id, tag_id}) =>
        `INSERT INTO problem_tag_map (problem_id, tag_id) VALUES (${problem_id}, ${tag_id});`).join('\n');
    log('writing sql');
    fs.writeFileSync('./add-tags.sql', sql);

    log('writing missing tags');
    fs.writeFileSync('./tags-missing.txt', Array.from(tagsMissing).join('\n'));

    log('ok');

    saveLogs();
})();
