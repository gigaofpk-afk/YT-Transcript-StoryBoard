const fs = require('fs');
const path = require('path');

const IS_CLOUD = !!(process.env.SPACE_ID || process.env.COLAB_GPU);

function initCloudGuards() {
    if (!IS_CLOUD) return;
    
    console.log("☁️  Cloud Environment Detected (Hugging Face / Colab). Initializing Cloud Guards...");

    // 1. Auto-Purge Ephemeral Storage
    // Runs every hour to clean up screenshots and scratch files older than 2 hours
    setInterval(() => {
        const dirsToClean = [
            path.join(__dirname, 'saved_screenshots'),
            path.join(__dirname, 'scratch')
        ];
        
        const now = Date.now();
        const maxAge = 2 * 60 * 60 * 1000; // 2 hours

        dirsToClean.forEach(dir => {
            if (!fs.existsSync(dir)) return;
            fs.readdir(dir, (err, files) => {
                if (err) return;
                files.forEach(file => {
                    const fp = path.join(dir, file);
                    fs.stat(fp, (err, stats) => {
                        if (err) return;
                        if (now - stats.mtimeMs > maxAge) {
                            try { fs.unlinkSync(fp); } catch(e) {}
                        }
                    });
                });
            });
        });
    }, 60 * 60 * 1000); // 1 hour
}

// 2. Cloud Path Disambiguation Guard
// Ensures cloud containers do not try to write to Windows drives (C:\, D:\)
function checkCloudPathGuard(destPath) {
    if (IS_CLOUD && destPath) {
        throw new Error("☁️ Cloud Security Guard: Cannot save directly to local PC folders when the server is running on Hugging Face or Colab. Please use the standard web ZIP download instead.");
    }
}

module.exports = {
    IS_CLOUD,
    initCloudGuards,
    checkCloudPathGuard
};
