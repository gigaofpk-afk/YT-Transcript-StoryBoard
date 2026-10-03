const { exec } = require('child_process');

async function runScreenshotTest() {
  console.log('--- Starting server on port 3050 for OCR Screenshot check ---');
  
  // Set alternative port so it does not conflict with user's running app
  process.env.PORT = '3050';
  const app = require('./server.js');
  app.listen(3050);

  // Wait 4 seconds for Tesseract.js / ytsr / Express to initialize
  await new Promise(resolve => setTimeout(resolve, 4000));

  console.log('\n--- Running loopback curl command for screenshot upload ---');
  // Specify MIME type explicitly using ;type=image/png
  const curlCmd = 'curl -s -X POST -F "screenshot=@sample_screenshot.png;type=image/png" http://localhost:3050/api/check-screenshot';
  
  exec(curlCmd, (err, stdout, stderr) => {
    if (err) {
      console.error('❌ Curl Request failed:', err.message);
      process.exit(1);
    }
    
    console.log('\n--- JSON Response from /api/check-screenshot ---');
    try {
      const data = JSON.parse(stdout);
      console.log(JSON.stringify(data, null, 2));
      
      // Check if it successfully extracted the text or performed a verification
      if (data.valid && (data.requireConfirmation || data.videoId)) {
        console.log('\n✅ TEST PASSED: Successfully identified video/triggered manual confirmation from OCR text!');
        process.exit(0);
      } else {
        console.error('\n❌ TEST FAILED: Response was invalid or failed to find match.');
        process.exit(1);
      }
    } catch (parseErr) {
      console.error('Failed to parse curl output as JSON:', stdout);
      process.exit(1);
    }
  });
}

runScreenshotTest();
