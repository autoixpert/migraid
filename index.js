#! /usr/bin/env node
const migraid     = require('commander');
const packageJson = require('./package');
const Migrator    = require('./lib/migrator');
const config      = require('config');

// Initialize the migrator with the options defined in config/[environment].js
const migrator = new Migrator();

migraid
    .version(packageJson.version);

// Handle uncaught promise errors
process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at: Promise ', p, ' reason: ', reason);
});

//*****************************************************************************
//  Prevent Beta Scripts From Being Added to Production
//****************************************************************************/
const isBeta = process.cwd()
    .includes('beta');
console.log('Current working directoy: ' + process.cwd());
if (isBeta) {
    console.log('Detected BETA directory. This is from where the scripts will be loaded.');
}
console.log('NODE_ENV set to: ' + config.util.getEnv('NODE_ENV') + '. This determines the database the scripts will be executed in.');
// If this environment is set to a production or development environment but the path contains the word "beta", throw an error. It is likely
// that "npx migraid up" was called in the beta repository causing beta migration scripts to be added to a production database. Not good.
if ((['production', 'development'].includes(config.util.getEnv('NODE_ENV')) || !config.util.getEnv('NODE_ENV')) && isBeta) {
    throw new Error('Error: Detected a NODE_ENV of production or development while being in a beta directory. You should execute "# npm run migraid-beta" instead of "# npx migraid up".');
}
/////////////////////////////////////////////////////////////////////////////*/
//  END Prevent Beta Scripts From Being Added to Production
/////////////////////////////////////////////////////////////////////////////*/

//*****************************************************************************
//  Create Empty Migration File
//****************************************************************************/
migraid
    .command('create [migrationName]')
    .description('Create a migration file.')
    .action(async function (migrationName, options) {
        try {
            const migrationFileName = await migrator.createMigrationFile({
                migrationName
            });
            console.log("Created migration file %s.", migrationFileName);
        }
        catch (error) {
            switch (error.message) {
                case "MISSING_MIGRATION_NAME":
                    console.log('Please specify a migration name.');
                    migraid.help();
                    break;
                default:
                    console.error('An error occurred.', error);
                    process.exit();
            }
        }
        process.exit();
    });

/////////////////////////////////////////////////////////////////////////////*/
//  END Create Empty Migration File
/////////////////////////////////////////////////////////////////////////////*/

//*****************************************************************************
//  Execute Migrations
//****************************************************************************/
migraid
    .command('up')
    .description('Execute all migrations that were not executed on this database.')
    .action(async function () {
        // Connect to Mongoose
        const connection = (await migrator.connect()).connection;

        try {
            const migratedFileNames = await migrator.up(connection);
        }
        catch (error) {
            console.error('Migration failedl.', error);
        }

        // Terminate the process
        process.exit();
    });
/////////////////////////////////////////////////////////////////////////////*/
//  END Execute Migrations
/////////////////////////////////////////////////////////////////////////////*/

// Parse the command line arguments and execute commands & options
migraid.parse(process.argv);