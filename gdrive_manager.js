const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Hugging Face Secrets will inject this
const serviceAccountJsonStr = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;

let drive = null;
let FOLDER_ID = null;

// Track file IDs on Drive to overwrite them instead of creating duplicates
const fileIdCache = {};

async function initGDrive() {
    if (!serviceAccountJsonStr) {
        console.log("☁️  GDRIVE_SERVICE_ACCOUNT_JSON not found. Google Drive sync is disabled.");
        return;
    }

    try {
        const credentials = JSON.parse(serviceAccountJsonStr);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });
        
        drive = google.drive({ version: 'v3', auth });
        
        // Find or create 'YouTubeChecker_Sync' folder
        const folderName = 'YouTubeChecker_Sync';
        const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
        const res = await drive.files.list({ q, fields: 'files(id, name)' });
        
        if (res.data.files.length > 0) {
            FOLDER_ID = res.data.files[0].id;
            console.log("☁️  Found existing GDrive sync folder:", FOLDER_ID);
        } else {
            const folderMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder'
            };
            const folderRes = await drive.files.create({
                resource: folderMetadata,
                fields: 'id'
            });
            FOLDER_ID = folderRes.data.id;
            console.log("☁️  Created new GDrive sync folder:", FOLDER_ID);
        }

        // Now download any existing state files to restore session!
        await restoreFromGDrive('history.json');
        await restoreFromGDrive('matches.json');
        await restoreFromGDrive('reports.json');
        
        console.log("☁️  Google Drive Sync successfully initialized!");
    } catch(e) {
        console.error("☁️  Failed to initialize GDrive sync:", e.message);
    }
}

async function restoreFromGDrive(filename) {
    if (!drive || !FOLDER_ID) return;
    try {
        const q = `'${FOLDER_ID}' in parents and name='${filename}' and trashed=false`;
        const res = await drive.files.list({ q, fields: 'files(id, name)' });
        
        if (res.data.files.length > 0) {
            const fileId = res.data.files[0].id;
            fileIdCache[filename] = fileId; // cache for future overwrites
            
            const dest = fs.createWriteStream(path.join(__dirname, filename));
            const dlRes = await drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream' }
            );
            
            dlRes.data.pipe(dest);
            await new Promise((resolve, reject) => {
                dest.on('finish', resolve);
                dest.on('error', reject);
            });
            console.log(`☁️  Restored ${filename} from GDrive.`);
        }
    } catch(e) {
        console.error(`☁️  Failed to restore ${filename}:`, e.message);
    }
}

async function uploadToGDrive(filename) {
    if (!drive || !FOLDER_ID) return;
    const filepath = path.join(__dirname, filename);
    if (!fs.existsSync(filepath)) return;
    
    try {
        const media = {
            mimeType: 'application/json',
            body: fs.createReadStream(filepath)
        };
        
        const fileId = fileIdCache[filename];
        if (fileId) {
            // Overwrite existing
            await drive.files.update({
                fileId,
                media,
                fields: 'id'
            });
            console.log(`☁️  Synced ${filename} to GDrive.`);
        } else {
            // Create new
            const fileMetadata = {
                name: filename,
                parents: [FOLDER_ID]
            };
            const res = await drive.files.create({
                resource: fileMetadata,
                media,
                fields: 'id'
            });
            fileIdCache[filename] = res.data.id;
            console.log(`☁️  Synced ${filename} to GDrive (New).`);
        }
    } catch(e) {
        console.error(`☁️  Failed to sync ${filename} to GDrive:`, e.message);
    }
}

module.exports = { initGDrive, uploadToGDrive };
