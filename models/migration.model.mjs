import mongoose from 'mongoose';

let migrationModel;

export default function ({migrationCollection}) {

    // Cache model
    if (migrationModel) {
        return migrationModel;
    }

    const MigrationSchema = new mongoose.Schema({
        _id : String, // Contains the filename of the given migration
    }, {
        timestamps : true,
        collection : migrationCollection
    });

    migrationModel = mongoose.model('Migration', MigrationSchema);

    return migrationModel;
};
