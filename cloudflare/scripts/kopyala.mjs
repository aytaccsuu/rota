// Arayüz dosyalarını (index.html, giris.html) ana klasörden public/ altına kopyalar.
// Böylece Render ve Cloudflare sürümleri aynı arayüzü kullanır; yalnızca bu iki dosya yayımlanır.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kok = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hedef = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(hedef, { recursive: true });
for (const ad of ['index.html', 'giris.html']) copyFileSync(join(kok, ad), join(hedef, ad));
console.log('Arayüz kopyalandı →', hedef);
