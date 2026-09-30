import { fileURLToPath } from 'node:url';
import { generateClient } from './client-generator/index.js';

export { generateClient } from './client-generator/index.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    generateClient().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
