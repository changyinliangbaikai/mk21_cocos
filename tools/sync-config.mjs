import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const source='docs/design/configs/prototype-v0.5.json';
const text=readFileSync(source,'utf8'); const config=JSON.parse(text);
mkdirSync('game/assets/resources',{recursive:true});
writeFileSync('game/assets/resources/prototype-v0.5.json',text);
console.log(`Runtime config synchronized from design v${config.design_version} (stable resource key: prototype-v0.5)`);
