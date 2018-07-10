const fs    = require('fs');
const path  = require('path');
const debug = require('debug')('migraid');
const util  = require('util');

// Suppress warnings if the including app does not contain config files.
process.env.SUPPRESS_NO_CONFIG_WARNING = 'y';
const config                           = require('config');

class Migrator {
    constructor({options} = {}) {
        const databaseConnection = config.has('db') && config.get('db');

        const moduleDefaults = {
            // The directory in which the migration files live
            directory  : 'migrations',
            host       : databaseConnection.host || '127.0.0.1',
            port       : databaseConnection.port || 27017,
            database   : databaseConnection.database || '',
            collection : '_migrations'
        };

        config.util.extendDeep(moduleDefaults, options);
        config.util.setModuleDefaults('migraid', moduleDefaults);

        // The Mongoose Migration model
        this.Migration = null;
    }

    /**
     * Connect to the MondoDB instance.
     */
    connect() {
        const mongoose = require('mongoose');

        this.Migration = require('../models/migration.model')({
            migrationCollection : config.get('migraid.collection')
        });

        mongoose.Promise = Promise;
        return mongoose.connect(`mongodb://${config.get('migraid.host')}:${config.get('migraid.port')}/${config.get('migraid.database')}`)
            .then(() => {
                debug('Connected to mongodb successfully. Database calls before establishing the connection were buffered and will excecute now.');
            })
            .catch(error => console.error('Error connecting to mongodb.', error));
    }

    /**
     * Start the migration process.
     * @return {Promise<any[]>} A list of migrated file names.
     */
    async up() {
        const [migrationFileNames, existingMigrations] = await Promise.all([
            this.getMigrationFileNames(),
            this.getDeployedMigrations()
        ]);

        const newMigrationFileNames = [];

        for (let migrationFileProperties of migrationFileNames) {
            // If the current file is not yet in the database, it's a new file.
            if (!existingMigrations.includes(migrationFileProperties.fileName)) {
                newMigrationFileNames.push(migrationFileProperties.fileName);
                debug('Found new migration file "%s"', migrationFileProperties.fileName);
            }
        }

        if (newMigrationFileNames.length === 0) {
            console.log('No new migration scripts found. The last added migration script was "%s". Exiting.', existingMigrations[existingMigrations.length - 1]);
            return Promise.resolve([]);
        }

        // Sort the file names alphabetically, so the oldest files with the lowest ID are added first.
        newMigrationFileNames.sort();

        for (const newMigrationFileName of newMigrationFileNames) {

            // Require acts relative to the current script, not to the current working directory of node. Thus, add node's current working
            // directory through process.env.PWD
            const migrationObject = require(path.join(process.env.PWD, config.get('migraid.directory'), newMigrationFileName));

            if (typeof migrationObject.up === "undefined") {
                console.error('No method "up()" exists on the migration object from file "%s".', newMigrationFileName);
                throw new Error('NO_UP_FUNCTION_AVAILABLE');
            }
            // Execute this migration script
            try {
                console.log('== Migrating "%s"...', newMigrationFileName);
                await migrationObject.up();
                console.log('== Migrated "%s".', newMigrationFileName);
            }
            catch (error) {
                console.error('Error executing migration script "%s".', newMigrationFileName, error);
                throw error;
            }

            // Mark the migration as completed
            const migration = new this.Migration({
                _id : newMigrationFileName
            });
            await migration.save();
        }

        return newMigrationFileNames;
    }

    async down() {
        // TODO Implement downgrading
    }

    /**
     * Creates a migration file in the migration directory with the next highest migration number
     * @param migrationName
     * @return {Promise<string>}
     */
    async createMigrationFile({migrationName}) {
        const writeFilePromise = util.promisify(fs.writeFile);
        const moment           = require('moment');

        if (!migrationName) {
            throw new Error('MISSING_MIGRATION_NAME');
        }
        const migrationFileName = moment()
                                      .format('YYYYMMDD_HHmmss') + '.' + migrationName.toLocaleLowerCase()
                                      .replace(/\s/g, '-') + '.js';

        // TODO Make the template configurable
        const template = `module.exports = {
    up : async () => {
        // Write migration code here
    },
    down : async () => {
        // Write code to roll back the migration here
    },
};`;
        try {
            await writeFilePromise(path.join(config.get('migraid.directory'), migrationFileName), template);
        }
        catch (error) {
            console.error('Error writing new migration file.', error);
            throw error;
        }
        return migrationFileName;
    }

    /**
     * Get an array of file names
     * @return {Promise<Array>}
     */
    async getMigrationFileNames() {
        const readdirPromise = util.promisify(fs.readdir);
        const statPromise    = util.promisify(fs.stat);

        let fileNames = [];
        try {
            fileNames = await readdirPromise(config.get('migraid.directory'));
            debug('Found filenames in migration directory', fileNames);
        }
        catch (error) {
            console.error('Error reading migration files.', error);
            throw error;
        }

        const migrationFileNames = [];

        for (let fileName of fileNames) {
            let stats;
            try {
                stats = await statPromise(path.join(config.get('migraid.directory'), fileName));
            }
            catch (error) {
                console.error('Error reading file stats of file "%s".', fileName, error);
            }
            if (stats.isDirectory()) continue;


            const migrationFileProperties = this.constructor.interpretFilename(fileName);

            migrationFileNames.push(migrationFileProperties);
        }

        return migrationFileNames;
    }

    /**
     * Get an array of migration names that were run in the past.
     * @return {Promise<void>}
     */
    async getDeployedMigrations() {
        return (await
                this.Migration.find()
        ).map(existingMigrationDocument => existingMigrationDocument.toObject()._id);
    }

//*****************************************************************************
//  Utility Functions
//****************************************************************************/
    static interpretFilename(filename) {
        // Match filenames in the format u2g52z354t-migration-name.js
        let matches = filename.match(/([\w_]+)\.([\w-_]+)\.js/);

        if (!matches) {
            matches = [];
        }

        return {
            fileName      : matches[0],
            datetime      : matches[1],
            migrationName : matches[2]
        };
    }

/////////////////////////////////////////////////////////////////////////////*/
//  END Utility Functions
/////////////////////////////////////////////////////////////////////////////*/
}

module.exports = Migrator;
