// Demo data: two accounts, a document with fields, and a pending signature request.
import { randomUUID } from 'node:crypto';
import { db, now } from './db.js';
import { createUser, getUserByEmail } from './auth.js';

const ensure = (email, name, plan) =>
  getUserByEmail(email) || createUser({ email, name, password: 'dochub-demo-8', plan });

const owner = ensure('ada@example.com', 'Ada Lovelace', 'pro');
const mate = ensure('blaise@example.com', 'Blaise Pascal', 'free');
db.prepare('UPDATE users SET plan=? WHERE id=?').run('pro', owner.id);

const docId = randomUUID();
db.prepare(`INSERT INTO documents (id,owner_id,title,state,page_count,created_at,updated_at)
            VALUES (?,?,?,'draft',1,?,?)`).run(docId, owner.id, 'Consulting agreement', now(), now());
const pageId = randomUUID();
db.prepare('INSERT INTO pages (id,document_id,position,width,height,blank) VALUES (?,?,0,612,792,1)')
  .run(pageId, docId);

const fields = [
  { type: 'text', name: 'full_name', x: 0.12, y: 0.30, w: 0.34, h: 0.035, required: 1, validation: 'none' },
  { type: 'text', name: 'email', x: 0.12, y: 0.37, w: 0.34, h: 0.035, required: 1, validation: 'email' },
  { type: 'date', name: 'start_date', x: 0.12, y: 0.44, w: 0.22, h: 0.035, required: 0, validation: 'date' },
  { type: 'checkbox', name: 'agrees', x: 0.12, y: 0.51, w: 0.03, h: 0.03, required: 1, validation: 'none' },
  { type: 'signature', name: 'signature', x: 0.12, y: 0.62, w: 0.26, h: 0.06, required: 1, validation: 'none' },
];
for (const f of fields) {
  db.prepare(`INSERT INTO formfields (id,document_id,page_id,type,name,placeholder,required,readonly,
              validation,options,value,x,y,w,h,font_size,created_at,updated_at)
              VALUES (?,?,?,?,?,'',?,0,?,'[]','',?,?,?,?,12,?,?)`)
    .run(randomUUID(), docId, pageId, f.type, f.name, f.required, f.validation, f.x, f.y, f.w, f.h, now(), now());
}
db.prepare('INSERT INTO folders (id,owner_id,name,color,created_at) VALUES (?,?,?,?,?)')
  .run(randomUUID(), owner.id, 'Clients', '#17b26a', now());

console.log('Seeded:');
console.log('  ada@example.com / dochub-demo-8   (Pro)');
console.log('  blaise@example.com / dochub-demo-8 (Free)');
console.log(`  document: ${docId} "Consulting agreement" with ${fields.length} fields`);
