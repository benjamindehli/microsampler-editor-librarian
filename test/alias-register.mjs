// registers the alias resolve hook (used via `node --import` before the tests)
import { register } from 'node:module';
register('./alias-resolve.mjs', import.meta.url);
