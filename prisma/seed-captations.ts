import type {PrismaClient} from '@prisma/client';
export async function seedCaptations(db:PrismaClient){
 for(const slug of ['demo-a','demo-b']){
 const tenant=await db.tenant.findUnique({where:{slug}});if(!tenant)continue;
 const admin=await db.user.findFirst({where:{tenantId:tenant.id,rol:'admin',estado:'activo',deletedAt:null}}),agent=await db.user.findFirst({where:{tenantId:tenant.id,rol:'agente',estado:'activo',deletedAt:null}});
 if(!admin||!agent)continue;
 const title=`QA · Captación ${slug.toUpperCase()}`;
 if(!await db.captation.findFirst({where:{tenantId:tenant.id,title}}))await db.captation.create({data:{tenantId:tenant.id,createdById:admin.id,assignedToId:agent.id,title,address:'Calle de prueba 123',city:'Ciudad de prueba',zone:'Centro',type:'departamento',operation:'alquiler',details:{bedrooms:2,bathrooms:1,coveredArea:65,totalArea:70,price:450000,currency:'ARS',expenses:40000,amenities:'Balcón y lavadero',services:'Luz, agua y gas',term:'24 meses',adjustment:'Trimestral, índice a confirmar',deposit:'1 mes',guarantees:'A confirmar',availability:'Disponible para visita',keys:'En oficina',visits:'Coordinar con responsable',notes:'Datos ficticios para pruebas locales.',publication:'pendiente'}}});
 }
}
