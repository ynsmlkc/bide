// Bazi cuzdan modulleri Node'un `Buffer` ve `process` globallerini bekliyor.
import { Buffer } from 'buffer'
export { Buffer }
export const process = { env: { NODE_ENV: 'production' }, browser: true, version: '', versions: {}, nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)) }
