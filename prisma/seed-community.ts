import type {PrismaClient} from '@prisma/client';
import bcrypt from 'bcrypt';
import {newDocumentKey,savePrivateFile} from '../src/lib/rental-documents-storage.js';
/** Called only by local-only seed entrypoints. Never changes existing accounts or documents. */
export async function seedCommunity(db:PrismaClient){
 const passwordHash=await bcrypt.hash('password123',12);
 for(const suffix of ['a','b']){
  const tenant=await db.tenant.findUnique({where:{slug:`demo-${suffix}`}});if(!tenant)continue;
  const admin=await db.user.findUnique({where:{email:`admin@demo-${suffix}.test`}});if(!admin||admin.tenantId!==tenant.id)continue;
  const email=`community@demo-${suffix}.test`;
  const existing=await db.user.findUnique({where:{email}});
  if(existing&&(existing.tenantId!==tenant.id||existing.rol!=='community'))throw new Error('La cuenta demo Community ya existe con otro rol o inmobiliaria.');
  const user=existing??await db.user.create({data:{tenantId:tenant.id,nombre:`Community Demo ${suffix.toUpperCase()}`,email,passwordHash,rol:'community'}});
  for(const [title,status,days] of [['Preparar contenido de propiedades','pendiente',1],['Revisar material compartido','en_curso',0],['Revisar borrador de publicación','pendiente',-1]] as const){
   if(!await db.teamTask.findFirst({where:{tenantId:tenant.id,assignedToId:user.id,title}}))await db.teamTask.create({data:{tenantId:tenant.id,assignedToId:user.id,createdById:admin.id,title,status,dueDate:new Date(Date.now()+days*86400000),description:'Tarea sintética para probar el espacio Community.',priority:days<0?'alta':'normal'}});
  }
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  for(const own of [true,false]){
   const title=own?'QA · Archivo propio Community':'QA · Material público del equipo';
   if(await db.rentalDocument.findFirst({where:{tenantId:tenant.id,title}}))continue;
   const key=newDocumentKey(tenant.id,user.id).replace(/pdf$/,'png');await savePrivateFile(key,png);
   await db.rentalDocument.create({data:{tenantId:tenant.id,uploadedById:own?user.id:admin.id,title,kind:'otro',visibility:'interna',accessMode:own?'admin':'team',teamPermission:'read',storageKey:key,mimeType:'image/png',originalName:'community-demo.png',size:png.length}});
  }
 }
}
