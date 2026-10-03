const fetch = require('node-fetch');

// Test dataset
const DATASET = [
  // 1. Standard Watch URL (Rick Astley - Never Gonna Give You Up)
  { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expectedValid: true, assert: (data) => data.valid && data.videoFound && data.transcriptAvailable },
  // 2. YouTu.be Short Link
  { url: 'https://youtu.be/dQw4w9WgXcQ', expectedValid: true, assert: (data) => data.valid && data.videoFound && data.transcriptAvailable },
  // 3. YouTube Shorts Link
  { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ', expectedValid: true, assert: (data) => data.valid && data.videoFound && data.transcriptAvailable },
  // 4. Invalid YouTube URL
  { url: 'https://example.com/not-youtube', expectedValid: false, assert: (data) => !data.valid && data.error === 'Not a valid YouTube URL.' },
  // 5. Invalid video ID (or nonexistent video transcript fetch)
  { url: 'https://www.youtube.com/watch?v=nonexistent1', expectedValid: true, assert: (data) => data.valid && !data.transcriptAvailable }
];

async function runTests() {
  console.log('--- Starting server in-process on port 3050 for automated self-testing ---');
  
  // Set dynamic port
  process.env.PORT = '3050';
  require('./server.js');

  // Wait 3 seconds for Express to boot up and initialize
  await new Promise(resolve => setTimeout(resolve, 3000));

  let passedTests = 0;
  let failedTests = 0;

  for (let i = 0; i < DATASET.length; i++) {
    const item = DATASET[i];
    console.log(`\n[Test ${i + 1}] Testing URL: "${item.url}"`);
    try {
      const res = await fetch('http://localhost:3050/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url })
      });
      
      const data = await res.json();
      console.log('Response:', JSON.stringify(data, null, 2));

      // Assertions
      if (item.assert(data)) {
        console.log('✅ TEST PASSED');
        passedTests++;
      } else {
        console.error('❌ TEST FAILED');
        failedTests++;
      }
    } catch (err) {
      console.error('❌ API Request Error:', err.message);
      failedTests++;
    }
  }

  console.log(`\nSummary: ${passedTests} passed, ${failedTests} failed.`);
  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
