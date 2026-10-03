const ytsr = require('ytsr');

async function test() {
  try {
    const videoId = 'dQw4w9WgXcQ'; // Rick Astley
    const searchResults = await ytsr(videoId, { limit: 1 });
    const video = searchResults.items[0];
    console.log(video);
  } catch (e) {
    console.error(e);
  }
}
test();
