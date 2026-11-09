import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";

export const captationRoutes = Router();
captationRoutes.use('/captations', requireAuth, requireRole('admin','agente'));
const text = (max=500) => z.string().trim().max(max).default('');
const amount = z.number().finite().min(0).max(999999999999).nullable().default(null);
const status = z.enum(['nueva','en_revision','lista','archivada']);
const fields = z.object({
 title:z.string().trim().min(3).max(160), address:z.string().trim().min(3).max(200), city:z.string().trim().min(2).max(120), zone:text(120),
 type:z.enum(['casa','departamento','duplex','local_comercial','oficina','galpon','cochera','terreno','otro']), operation:z.enum(['venta','alquiler']), status:status.default('nueva'),
 assignedToId:z.string().uuid().optional(), ownerPersonId:z.string().uuid().nullable().optional(), propertyId:z.string().uuid().nullable().optional(),
 details:z.object({ bedrooms:amount, bathrooms:amount, coveredArea:amount,totalArea:amount,price:amount,currency:z.enum(['ARS','USD']),expenses:amount,
 amenities:text(1000),services:text(1000),term:text(120),adjustment:text(200),deposit:text(200),guarantees:text(500),availability:text(300),keys:text(200),visits:text(500),notes:text(3000),
 publication:z.enum(['pendiente','autorizada','no_publicar']).default('pendiente') }).strict()
}).strict();
const idParam=z.string().uuid();
async function enrich(tx:Tx, rows:Awaited<ReturnType<Tx['captation']['findMany']>>, admin:boolean) {
 const ids=[...new Set(rows.map(x=>x.assignedToId))];
 const users=await tx.user.findMany({where:{id:{in:ids}},select:{id:true,nombre:true}});
 return rows.map(row=>({...row,ownerPersonId:admin?row.ownerPersonId:null,assignedTo:users.find(u=>u.id===row.assignedToId)??null}));
}
captationRoutes.get('/captations',async(req,res)=>{
 const f=z.object({q:z.string().trim().max(160).optional(),status:status.optional(),page:z.coerce.number().int().min(1).max(100000).default(1)}).parse(req.query);
 const auth=req.auth!;
 res.json(await runWithContext(auth,async tx=>{
 const where={tenantId:auth.tenantId!,...(auth.rol==='agente'?{assignedToId:auth.userId}:{}),status:f.status,...(f.q?{OR:[{title:{contains:f.q,mode:'insensitive' as const}},{address:{contains:f.q,mode:'insensitive' as const}}]}:{})};
 const [rows,total]=await Promise.all([tx.captation.findMany({where,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(f.page-1)*24,take:24}),tx.captation.count({where})]);
 return {data:await enrich(tx,rows,auth.rol==='admin'),meta:{total,page:f.page,limit:24}};
 }));
});
captationRoutes.get('/captations/:id',async(req,res)=>{
 const id=idParam.parse(req.params.id),auth=req.auth!;
 res.json(await runWithContext(auth,async tx=>{
 const row=await tx.captation.findFirst({where:{id,tenantId:auth.tenantId!}});
 if(!row)throw new ApiError('NOT_FOUND','La captación no existe.');
 return {item:(await enrich(tx,[row],auth.rol==='admin'))[0]};
 }));
});
for(const method of ['post','patch'] as const)captationRoutes[method](method==='post'?'/captations':'/captations/:id',async(req,res)=>{
 const body=fields.parse(req.body),auth=req.auth!,id=method==='patch'?idParam.parse((req.params as {id:string}).id):null;
 const item=await runWithContext(auth,async tx=>{
 const existing=id?await tx.captation.findFirst({where:{id,tenantId:auth.tenantId!}}):null;
 if(id&&!existing)throw new ApiError('NOT_FOUND','La captación no existe.');
 if(auth.rol!=='admin'&&(body.assignedToId&&body.assignedToId!==auth.userId||body.ownerPersonId!==undefined||body.propertyId!==undefined))throw new ApiError('FORBIDDEN','Solo administración puede asignar responsables y vincular clientes o propiedades.');
 const assignedToId=auth.rol==='admin'?(body.assignedToId??existing?.assignedToId??auth.userId):auth.userId;
 const user=await tx.user.findFirst({where:{id:assignedToId,tenantId:auth.tenantId!,estado:'activo',deletedAt:null,rol:{in:['admin','agente']}}});
 if(!user)throw new ApiError('VALIDATION_ERROR','Elegí un administrador o agente activo.');
 if(body.ownerPersonId&&!await tx.rentalPerson.findFirst({where:{id:body.ownerPersonId,tenantId:auth.tenantId!}}))throw new ApiError('VALIDATION_ERROR','El cliente no pertenece a tu inmobiliaria.');
 if(body.propertyId&&!await tx.property.findFirst({where:{id:body.propertyId,tenantId:auth.tenantId!}}))throw new ApiError('VALIDATION_ERROR','La propiedad no pertenece a tu inmobiliaria.');
 const data={...body,assignedToId};
 return id?tx.captation.update({where:{id},data}):tx.captation.create({data:{...data,tenantId:auth.tenantId!,createdById:auth.userId}});
 });
 res.status(id?200:201).json({item:{...item,ownerPersonId:auth.rol==='admin'?item.ownerPersonId:null}});
});
