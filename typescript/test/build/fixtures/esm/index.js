import { MongoDBMemoryStore, MongoDBStorage } from 'strands-mongodb'
import { MongoDBMemoryStore as MemoryStore } from 'strands-mongodb/memory'
import { MongoDBStorage as Storage, MongoDBVectorSearchStrategy } from 'strands-mongodb/storage'

if (typeof MongoDBStorage !== 'function') throw new Error('MongoDBStorage is not a class')
if (Storage !== MongoDBStorage || MemoryStore !== MongoDBMemoryStore) throw new Error('subpaths disagree with the root')
if (typeof MongoDBVectorSearchStrategy !== 'function') throw new Error('MongoDBVectorSearchStrategy is not a class')
new MongoDBStorage({ database: 'x', connectionString: 'mongodb://localhost' })
console.log('ok')
