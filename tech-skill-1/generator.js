const { getRandomInteger } = require("./random.js");

// Set up a scenario where we generate 20 random integers
// between 0 and 100, but some of the promises may fail
// due to insufficient entropy.
const promises = [];
const results = [];
const errors = [];
for (let i = 0; i < 20; i++) {
  promises.push(getRandomInteger(100));
}

// Use Promise.allSettled to handle all promises
// and collect results and errors.
Promise.allSettled(promises)
  .then((data) => {
    data.forEach((result, index) => {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        errors.push(result.reason);
      }
    });
  })
  .finally(() => {
    // Log results sorted ascending
    // and the number of errors encountered.
    console.log("Generated Numbers:", results.sort((a, b) => a - b));
    console.log("Failed Attempts:", errors.length);
  });

  // Test that number of results is equal to
  // the number of promises minus the number of errors.
  Promise.allSettled(promises)
    .then((data) => {
      const fulfilledCount = data.filter(result => result.status === 'fulfilled').length;
      const errorCount = data.filter(result => result.status === 'rejected').length;
      console.assert(fulfilledCount + errorCount === promises.length, "Mismatch in counts");
    })
    .catch((error) => {
      console.error("Error in assertion:", error);
    }
  );