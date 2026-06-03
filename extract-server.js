const http = require('http');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8');
      const j = JSON.parse(body);
      const archive_b64 = j.archive_b64;
      const dest = j.dest || '/home/node/facturas/work';

      if (!archive_b64 || archive_b64.length === 0) {
        throw new Error('archive_b64 vacio o faltante. Keys recibidas: ' + Object.keys(j).join(', '));
      }

      const archiveBuffer = Buffer.from(archive_b64, 'base64');
      console.log('Decodificado:', archiveBuffer.length, 'bytes');

      const archivePath = '/home/node/facturas/_upload.archive';
      fs.writeFileSync(archivePath, archiveBuffer);
      console.log('Guardado en:', archivePath);

      try { fs.rmSync(dest, { recursive: true, force: true }); } catch(e) {}
      fs.mkdirSync(dest, { recursive: true });

      const magic = archiveBuffer.slice(0, 8).toString('hex');
      console.log('Magic bytes:', magic);

      if (magic.startsWith('504b')) {
        execFileSync('unzip', ['-o', archivePath, '-d', dest + '/'], { stdio: 'pipe' });
        console.log('Extraido con unzip');
      } else {
        execFileSync('/usr/bin/bsdtar', ['x', '-f', archivePath, '-C', dest + '/'], { stdio: 'pipe' });
        console.log('Extraido con bsdtar');
      }

      const flatten = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() === false) continue;
          const sub = path.join(dir, e.name);
          flatten(sub);
          const subEntries = fs.readdirSync(sub, { withFileTypes: true });
          for (const f of subEntries) {
            if (f.isFile() === false) continue;
            const ext = path.extname(f.name).toLowerCase();
            if (['.pdf', '.jpg', '.jpeg', '.png'].includes(ext)) {
              const src = path.join(sub, f.name);
              const dst = path.join(dest, f.name);
              if (fs.existsSync(dst) === false) fs.renameSync(src, dst);
            }
          }
        }
      };
      try { flatten(dest); } catch(e) { console.log('flatten skip:', e.message); }

      const files = fs.readdirSync(dest);
      console.log('OK:', files.length, 'archivos extraidos');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, magic, files }));
    } catch(e) {
      console.error('Error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}).listen(5679, '0.0.0.0', () => console.log('Extractor HTTP listo en 5679'));
