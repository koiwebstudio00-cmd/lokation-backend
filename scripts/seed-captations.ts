import 'dotenv/config';
import {PrismaClient} from '@prisma/client';
import {seedCaptations} from '../prisma/seed-captations.js';
const url=process.env.DATABASE_URL_MIGRATE;
if(!url)throw new Error('Falta DATABASE_URL_MIGRATE');
const target=new URL(url);
if(process.env.NODE_ENV==='production'||!['localhost','127.0.0.1'].includes(target.hostname)||target.port!=='5433'||target.pathname!=='/ubikka_dev')throw new Error('Solo permitido en ubikka_dev local (5433).');
const db=new PrismaClient({datasources:{db:{url}}});
try{await seedCaptations(db);console.log('Captaciones sintéticas preparadas en Demo A/B sin modificar registros existentes.');}finally{await db.$disconnect();}
