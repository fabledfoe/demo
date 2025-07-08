// random.js
function urandGenerate() {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() <= 0.3) {
        reject("not enough entropy");
      } else {
        resolve(Math.random());
      }
    }, 2000 * Math.random());
  });
}
module.exports.getRandomInteger = async function (max) {
  let f = await urandGenerate();
  return Math.floor(f * max);
};
