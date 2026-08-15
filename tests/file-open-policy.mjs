import assert from 'node:assert/strict';
import { automaticHandler } from '../js/core/file-open-policy.js';

const tool = (id, accepts) => ({ id, accepts });
const hex = tool('hex-viewer', ['*']);
const images = tool('image-viewer', ['.png', '.jpg', '.bmp']);
const editor = tool('image-studio', ['.png', '.jpg']);
const sfo = tool('sfo-studio', ['.sfo']);
const decrypt = tool('eboot-decrypter', ['EBOOT.BIN', '.prx']);

assert.equal(automaticHandler('raw.dat', [hex])?.id, 'hex-viewer', 'wildcard fallback should open generic files');
assert.equal(automaticHandler('PARAM.SFO', [hex, sfo])?.id, 'sfo-studio', 'specific handler must beat wildcard fallback');
assert.equal(automaticHandler('EBOOT.BIN', [hex, decrypt])?.id, 'eboot-decrypter', 'exact PSP handler must beat wildcard fallback');
assert.equal(automaticHandler('PIC1.PNG', [hex, images, editor])?.id, 'image-viewer', 'image viewer must be the default for images');
assert.equal(automaticHandler('photo.bmp', [hex, images])?.id, 'image-viewer', 'image viewer must also win when it is the only explicit image handler');
assert.equal(automaticHandler('dual.bin', [hex, tool('a', ['.bin']), tool('b', ['.bin'])]), null, 'multiple specialized handlers should require Open With');
assert.equal(automaticHandler('none.bin', []), null);

console.log('file-open-policy: ok');
