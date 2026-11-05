try {
  const { MongoDBStorage } = require('strands-mongodb')
  console.log(JSON.stringify({ loaded: typeof MongoDBStorage }))
} catch (error) {
  console.log(JSON.stringify({ code: error.code }))
}
