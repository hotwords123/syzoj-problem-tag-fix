
'use strict';

const fs   = require('fs');

class FileCache extends Map {
    constructor(filename, noload = false) {
        super();
        this.filename = filename;
        if (!noload) this.load();
    }
    fromJSON(data, noclear = false) {
        if (!noclear) this.clear();
        for (let {key, value} of data) {
            this.set(key, value);
        }
    }
    toJSON() {
        let result = [];
        for (let [key, value] of this) {
            result.push({ key, value });
        }
        return result;
    }
    load(noclear = false) {
        try {
            this.fromJSON(JSON.parse(fs.readFileSync(this.filename).toString()), noclear);
            return true;
        } catch (err) {
            return false;
        }
    }
    save() {
        try {
            fs.writeFileSync(this.filename, JSON.stringify(this.toJSON()));
            return true;
        } catch (err) {
            return false;
        }
    }
}

module.exports = FileCache;