import fs from 'fs';
import path from 'path';
import debug from 'debug';
import util from 'util';
import mongoose from 'mongoose';
import Migration from '../models/migration.model.mjs';
import moment from 'moment';

// Suppress warnings if the including app does not contain config files.
process.env.SUPPRESS_NO_CONFIG_WARNING = 'y';
// Required so that the default database config from the parent module can be read into the default of migraid's config.
process.env.ALLOW_CONFIG_MUTATIONS     = 'yes';
import config from 'config';

export class Migrator {
    constructor({options} = {}) {
        const databaseConnection = config.has('db') && config.get('db');

        const moduleDefaults = {
            // The directory from which the migration files are read.
            distDirectory : 'migrations',
            // The directory in which new migration files are created.
            sourcesDirectory : 'migrations',
            host             : databaseConnection.host || '127.0.0.1',
            port             : databaseConnection.port || 27017,
            database         : databaseConnection.database || '',
            collection       : '_migrations'
        };

        config.util.extendDeep(moduleDefaults, options);
        config.util.setModuleDefaults('migraid', moduleDefaults);

        // The Mongoose Migration model
        this.Migration = null;
    }

    /**
     * Connect to the MondoDB instance.
     */
    async connect() {

        //*****************************************************************************
        //  Configure Mongoose
        //****************************************************************************/
        let configureMongoose;
        try {
            const configureMongooseModuleExport = await import(path.join(process.cwd(), '/src/lib/configure-mongoose.js'));
            // This file is not part of this project but of the project that includes migraid as a module.
            configureMongoose                   = configureMongooseModuleExport.configureMongoose || configureMongooseModuleExport;
            try {
                configureMongoose(mongoose);
                console.info('Used /src/lib/configure-mongoose.js to modify the mongoose object.');
            }
            catch (error) {
                console.error('Could not configure the mongoose object.', error);
            }
        }
        catch (error) {
            console.info('No Mongoose configuration found. You may modify the mongoose object in a file called /src/lib/configure-mongoose.js in the project directory.');
        }
        /////////////////////////////////////////////////////////////////////////////*/
        //  END Configure Mongoose
        /////////////////////////////////////////////////////////////////////////////*/

        this.Migration = Migration({
            migrationCollection : config.get('migraid.collection')
        });

        mongoose.Promise = Promise;
        return mongoose.connect(`mongodb://${config.get('migraid.host')}:${config.get('migraid.port')}/${config.get('migraid.database')}`, {
                useNewUrlParser    : true,
                useUnifiedTopology : true
            })
            .then((connection) => {
                debug('migraid')('Connected to mongodb successfully. Database calls before establishing the connection were buffered and will excecute now.');
                return connection;
            })
            .catch(error => console.error('Error connecting to mongodb.', error));
    }

    /**
     * Start the migration process.
     * @return {Promise<any[]>} A list of migrated file names.
     */
    async up(connection) {
        const [migrationFileNames, existingMigrations] = await Promise.all([
            this.getMigrationFileNames(),
            this.getDeployedMigrations()
        ]);

        const newMigrationFileNames = [];

        for (let migrationFileProperties of migrationFileNames) {
            // If the current file is not yet in the database, it's a new file.
            if (!existingMigrations.includes(migrationFileProperties.fileName)) {
                newMigrationFileNames.push(migrationFileProperties.fileName);
                debug('migraid')('Found new migration file "%s"', migrationFileProperties.fileName);
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
            const migrationModule = await import(path.join(process.env.PWD, config.get('migraid.distDirectory'), newMigrationFileName));
            const migrationObject = migrationModule.default || migrationModule;

            if (typeof migrationObject.up === "undefined") {
                console.error('No method "up()" exists on the migration object from file "%s".', newMigrationFileName);
                throw new Error('NO_UP_FUNCTION_AVAILABLE');
            }
            // Execute this migration script
            try {
                console.log("\n\n== Migrating '%s'...", newMigrationFileName);
                await migrationObject.up(connection);
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

    /**
     * Creates a migration file in the migration directory with the next highest migration number
     * @param migrationName
     * @return {Promise<string>}
     */
    async createMigrationFile({migrationName}) {
        const writeFilePromise = util.promisify(fs.writeFile);

        if (!migrationName) {
            throw new Error('MISSING_MIGRATION_NAME');
        }
        const migrationFileName = moment()
                                      .format('YYYYMMDD_HHmmss') + '.' + migrationName.toLocaleLowerCase()
                                      .replace(/\s/g, '-') + '.ts';
        const migrationFilePath = path.join(config.get('migraid.sourcesDirectory'), migrationFileName);

        // TODO Make the template configurable
        const template = `import {axLogger} from "../lib/ax-logger/ax-logger.js";
import {Connection} from "mongoose";

export default {
    up : async (connection: Connection) => {
        // Write migration code here
    }
};`;
        try {
            await writeFilePromise(migrationFilePath, template);
        }
        catch (error) {
            console.error('Error writing new migration file.', error);
            throw error;
        }
        return migrationFilePath;
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
            fileNames = await readdirPromise(config.get('migraid.distDirectory'));
            debug('migraid')('Found filenames in migration directory', fileNames);
        }
        catch (error) {
            console.error('Error reading migration files.', error);
            throw error;
        }

        const migrationFileNames = [];

        for (let fileName of fileNames) {
            let stats;
            try {
                stats = await statPromise(path.join(config.get('migraid.distDirectory'), fileName));
            }
            catch (error) {
                console.error('Error reading file stats of file "%s".', fileName, error);
            }
            if (stats.isDirectory()) continue;
            // Ensure there is a .ts file. TypeScript files are usually tracked via git while .js and .map files are ignored, so look for .ts files first.
            if (path.extname(fileName) !== '.ts') continue;

            const javascriptFilename = fileName.replace(/\.ts$/, '.js');
            try {
                await fs.promises.access(path.join(config.get('migraid.distDirectory'), javascriptFilename));
            }
            catch (error) {
                console.error(`Error accessing JavaScript migration file "${javascriptFilename}".`, error);
                throw new Error(`Found a TypeScript migration file "${fileName}" for which there is no JavaScript file "${javascriptFilename}".`);
            }


            const migrationFileProperties = this.constructor.interpretFilename(javascriptFilename);

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
            throw new Error(`Filename "${filename}" does not match the required migration filename pattern. Please add the file using "npx migraid create"`);
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
