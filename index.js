#! /usr/bin/env node
const migraid     = require('commander');
const packageJson = require('./package');
const Migrator    = require('./lib/migrator');

// Initialize the migrator with the options defined in config/[environment].js
const migrator = new Migrator();

migraid
    .version(packageJson.version);

// Handle uncaught promise errors
process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at: Promise ', p, ' reason: ', reason);
});

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
        await migrator.connect();

        try {
            const migratedFileNames = await migrator.up();
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