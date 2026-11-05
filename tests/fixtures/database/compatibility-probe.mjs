import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {FOUNDATION, DATABASE_CHECKS} from "../../../scripts/security/database-compatibility.mjs";
const input=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const sha=file=>hash(fs.readFileSync(file));
assert.equal(process.platform,"linux");
assert.equal(fs.realpathSync(process.cwd()),fs.realpathSync(input.project));
for(const key of Object.keys(process.env))assert.ok(!/^(DATABASE_URL|DIRECT_URL|SHOPIFY_|KOMOJU_|RESEND_|GITHUB_TOKEN|GH_TOKEN)/i.test(key));
for(const role of ["library","schema"])assert.equal(sha(input[role]),input[`${role}Sha256`]);
const url=(database,port=input.postgresPort)=>{
  assert.ok(["oja_probe","oja_app_probe","oja_history_probe","oja_partial_probe","oja_late_probe"].includes(database));
  assert.ok(Number.isInteger(port)&&port>0&&port<=65535);
  const value=new URL(`postgresql://localhost:${port}/${database}`);
  value.username="oja_probe";value.password="oja-ephemeral-test-only";
  value.searchParams.set("sslmode","require");value.searchParams.set("sslaccept","strict");value.searchParams.set("sslcert",input.tls.caFile);
  value.searchParams.set("connection_limit","1");value.searchParams.set("connect_timeout","5");
  return value.href;
};
const env={...process.env,DATABASE_URL:url("oja_app_probe"),PRISMA_QUERY_ENGINE_LIBRARY:input.library,PRISMA_SCHEMA_ENGINE_BINARY:input.schema,
  PRISMA_CLIENT_ENGINE_TYPE:"library",PRISMA_CLI_QUERY_ENGINE_TYPE:"library",PRISMA_GENERATE_SKIP_AUTOINSTALL:"1",
  CHECKPOINT_DISABLE:"1",PRISMA_HIDE_UPDATE_MESSAGE:"1",DO_NOT_TRACK:"1",OJA_PRISMA_PROBE_INPUT:process.argv[2]};
Object.assign(process.env,env);
let commandIndex=0;
const command=(project,args,database="oja_app_probe",expected=0)=>{
  const r=spawnSync(process.execPath,["--require",input.cliHook,input.cli,...args,"--config",path.join(project,"prisma.config.ts")],
    {cwd:project,env:{...env,DATABASE_URL:url(database)},encoding:"utf8",timeout:90000,maxBuffer:8*1024*1024});
  fs.writeFileSync(path.join(input.project,`cli-${++commandIndex}.log`),(r.stdout||"")+(r.stderr||""));
  assert.equal(r.error,undefined);assert.equal(r.status,expected,r.stderr);assert.ok(!r.stderr.includes("Environment variables loaded from"));
  return (r.stdout||"")+(r.stderr||"");
};
const loaded=new Set(),dlopen=process.dlopen;
process.dlopen=function(module,filename,...args){assert.equal(fs.realpathSync(filename),fs.realpathSync(input.library));assert.equal(sha(filename),input.librarySha256);loaded.add(input.librarySha256);return Reflect.apply(dlopen,this,[module,filename,...args]);};
const require=createRequire(path.join(input.project,"package.json"));
const checks=[];
const record=async(name,action)=>{await action();checks.push(name);};
const native=require(input.library);assert.equal(native.version().commit,input.sourceCommit);
command(input.project,["generate"]);
const {PrismaClient,Prisma}=require("@prisma/client");
assert.equal(Prisma.prismaVersion.client,"6.19.3");
const admin=new PrismaClient({datasourceUrl:url("oja_probe"),log:[]});
let client,modelsChecked=0,historyRegression,poolers=[],baselineState=[],postgres;
try{
  await record("native-identity",async()=>{
    await admin.$connect();assert.deepEqual([...loaded],[input.librarySha256]);assert.equal(admin._engine.versionInfo.commit,input.sourceCommit);
  });
  await record("postgres-server-identity",async()=>{
    const [row]=await admin.$queryRawUnsafe("SELECT current_setting('server_version_num')::int AS version_num,ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()");
    assert.equal(row.version_num,input.tls.serverVersionNum);assert.equal(row.ssl,true);assert.ok(["TLSv1.2","TLSv1.3"].includes(row.version));
    postgres={image:input.tls.image,serverVersionNum:row.version_num,encrypted:row.ssl,tlsVersion:row.version};
    fs.writeFileSync(path.join(input.project,"postgres-identity.json"),JSON.stringify(postgres));
    for(const database of ["oja_app_probe","oja_history_probe","oja_partial_probe","oja_late_probe"])await admin.$executeRawUnsafe(`CREATE DATABASE ${database}`);
  });
  await record("original-history-regression",()=>{
    const output=command(input.historyProject,["migrate","deploy"],"oja_history_probe",1);
    assert.match(output,/P3018/);assert.match(output,/42P01/);assert.match(output,/Product/);assert.match(output,/20260409193000_add_product_shop_domain/);
    historyRegression={code:"P3018",sqlState:"42P01",missingTable:"Product"};
  });
  client=new PrismaClient({datasourceUrl:url("oja_app_probe"),log:[]});
  await record("fresh-full-migration-history",async()=>{
    command(input.project,["migrate","deploy"]);command(input.project,["migrate","deploy"]);
    const rows=await client.$queryRawUnsafe('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
    const files=input.inputs.filter(e=>e.path.endsWith("/migration.sql"));
    assert.equal(rows.length,files.length);
    for(let i=0;i<rows.length;i++){assert.equal(rows[i].migration_name,files[i].path.split("/")[2]);assert.equal(rows[i].checksum,files[i].sha256);assert.ok(rows[i].finished_at instanceof Date);assert.equal(rows[i].rolled_back_at,null);}
  });
  await record("schema-drift",()=>{command(input.project,["migrate","diff","--from-url",url("oja_app_probe"),"--to-schema-datamodel",path.join(input.project,"prisma/schema.prisma"),"--exit-code"]);});
  const modelTables=Prisma.dmmf.datamodel.models.map(model=>model.dbName||model.name);
  const state=async()=>{
    const result=[];
    for(const table of modelTables){
      assert.match(table,/^[a-zA-Z][a-zA-Z0-9_]*$/);
      const [row]=await client.$queryRawUnsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${table}" AS t`);
      result.push({table,count:row.rows.length,sha256:hash(JSON.stringify(row.rows))});
    }
    return result;
  };
  await record("all-model-tables",async()=>{
    baselineState=await state();modelsChecked=modelTables.length;assert.ok(modelsChecked>20);
    for(const item of baselineState)assert.equal(item.count,["VendorStore","Vendor","sellers"].includes(item.table)?1:0,item.table);
    assert.equal((await client.vendorStore.findUnique({where:{id:"platform_store_oja_immanuel_bacchus"}})).isPlatformStore,true);
    fs.writeFileSync(path.join(input.project,"baseline-state.json"),JSON.stringify(baselineState));
  });
  const foundation=fs.readFileSync(path.join(input.project,"prisma/migrations",FOUNDATION,"migration.sql"),"utf8");
  await record("foundation-existing-data-noop",async()=>{
    const store=await client.vendorStore.create({data:{ownerName:"synthetic",storeName:"synthetic",email:"probe@example.invalid",phone:"synthetic",address:"synthetic",country:"JP",category:"synthetic",ageCheck:"synthetic"}});
    const product=await client.product.create({data:{name:"synthetic",price:300,costAmount:new Prisma.Decimal("12.34"),vendorStoreId:store.id}});
    assert.equal(product.costAmount.toString(),"12.34");
    const before=await client.$queryRawUnsafe("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname");
    // Only this disposable DB: emulate an existing installation with the original
    // 49 applied migrations and real-shaped data, then deploy the missing one.
    const historyBefore=await client.$queryRawUnsafe('SELECT id,migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name');
    assert.equal(await client.$executeRaw`DELETE FROM "_prisma_migrations" WHERE migration_name = ${FOUNDATION}`,1);
    command(input.project,["migrate","deploy"]);
    const historyAfter=await client.$queryRawUnsafe('SELECT id,migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name');
    assert.equal(historyAfter.length,historyBefore.length);
    assert.deepEqual(historyAfter.filter(r=>r.migration_name!==FOUNDATION),historyBefore.filter(r=>r.migration_name!==FOUNDATION));
    assert.equal(historyAfter.find(r=>r.migration_name===FOUNDATION).checksum,historyBefore.find(r=>r.migration_name===FOUNDATION).checksum);
    assert.deepEqual(await client.product.findUnique({where:{id:product.id}}),product);
    assert.deepEqual(await client.$queryRawUnsafe("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname"),before);
    await client.product.delete({where:{id:product.id}});await client.vendorStore.delete({where:{id:store.id}});
  });
  await record("foundation-partial-rejected",async()=>{
    const partial=new PrismaClient({datasourceUrl:url("oja_partial_probe"),log:[]});
    try{await partial.$executeRawUnsafe('CREATE TABLE "Product" ("id" TEXT)');await assert.rejects(partial.$executeRawUnsafe(foundation),error=>error.code==="P2010"&&error.meta?.message.includes("legacy_foundation_partial_schema"));
      const [row]=await partial.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");assert.equal(row.count,1);
    }finally{await partial.$disconnect();}
  });
  await record("foundation-later-history-rejected",async()=>{
    const late=new PrismaClient({datasourceUrl:url("oja_late_probe"),log:[]});
    try{await late.$executeRawUnsafe('CREATE TABLE "_prisma_migrations" (migration_name TEXT, finished_at TIMESTAMP, rolled_back_at TIMESTAMP)');
      await late.$executeRawUnsafe("INSERT INTO \"_prisma_migrations\" (migration_name,finished_at) VALUES ('20260501120000_add_seller_payments_mvp',CURRENT_TIMESTAMP)");
      await assert.rejects(late.$executeRawUnsafe(foundation),error=>error.code==="P2010"&&error.meta?.message.includes("legacy_foundation_later_history_without_tables"));
      const [row]=await late.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");assert.equal(row.count,1);
    }finally{await late.$disconnect();}
  });
  await record("application-types-and-relations",async()=>{
    const order=await client.marketplaceOrder.create({data:{shopDomain:"synthetic.invalid",shopifyOrderId:"synthetic-order",totalAmount:300,metadataJson:{synthetic:true},sellerOrders:{create:{shopifyOrderId:"synthetic-order",sellerId:"synthetic-seller",sellerNetAmount:300,lines:{create:{shopifyLineItemId:"synthetic-line",quantity:2,unitAmount:150,netAmount:300}}}}},include:{sellerOrders:{include:{lines:true}}}});
    assert.equal(order.sellerOrders[0].lines[0].netAmount,300);assert.deepEqual(order.metadataJson,{synthetic:true});
    await client.ledgerEntry.create({data:{entryType:"synthetic",amount:300,direction:"credit",occurredAt:new Date("2026-11-05T00:00:00Z")}});
    const session=await client.session.create({data:{id:"synthetic-session",shop:"synthetic.invalid",state:"synthetic",accessToken:"synthetic-not-credential",userId:9007199254740993n}});assert.equal(session.userId,9007199254740993n);
    await client.marketplaceOrder.delete({where:{id:order.id}});assert.equal(await client.sellerOrderLine.count(),0);await client.ledgerEntry.deleteMany();await client.session.deleteMany();
  });
  for(const [index,pooler]of input.poolers.entries())await record(index===0?"compatibility-pool":"prepared-pool",async()=>{
    const pooled=new URL(url("oja_app_probe",pooler.port));if(!pooler.prepared)pooled.searchParams.set("pgbouncer","true");
    const clients=[],pids=new Set();let serverTlsVersion;
    try{
      for(let i=0;i<12;i++){
        const probe=new PrismaClient({datasourceUrl:pooled.href,log:[]});clients.push(probe);await probe.$connect();
        const [row]=await probe.$queryRawUnsafe("SELECT pg_backend_pid() AS pid,ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()");assert.equal(row.ssl,true);assert.ok(["TLSv1.2","TLSv1.3"].includes(row.version));serverTlsVersion=row.version;pids.add(row.pid);
      }
      assert.equal(pids.size,1);
      for(let i=0;i<clients.length;i++)for(let n=0;n<3;n++){const [row]=await clients[i].$queryRaw`SELECT ${i+n}::int AS value`;assert.equal(row.value,i+n);}
      const probe=clients[0],key=`synthetic-${pooler.mode}`;
      await probe.operationalHeartbeat.create({data:{key,metadataJson:{synthetic:true,value:3}}});assert.deepEqual((await probe.operationalHeartbeat.findUnique({where:{key}})).metadataJson,{synthetic:true,value:3});
      await assert.rejects(probe.operationalHeartbeat.create({data:{key}}),error=>error.code==="P2002");
      await assert.rejects(probe.$transaction([probe.operationalHeartbeat.create({data:{key:`${key}-batch`}}),probe.operationalHeartbeat.create({data:{key}})]),error=>error.code==="P2002");assert.equal(await probe.operationalHeartbeat.findUnique({where:{key:`${key}-batch`}}),null);
      await probe.$transaction(async tx=>{await tx.operationalHeartbeat.create({data:{key:`${key}-commit`}});});assert.ok(await probe.operationalHeartbeat.findUnique({where:{key:`${key}-commit`}}));
      await assert.rejects(probe.$transaction(async tx=>{await tx.operationalHeartbeat.create({data:{key:`${key}-rollback`}});throw new Error("synthetic_rollback");}),/synthetic_rollback/);assert.equal(await probe.operationalHeartbeat.findUnique({where:{key:`${key}-rollback`}}),null);
      await probe.$disconnect();await probe.$connect();assert.equal(await probe.operationalHeartbeat.count(),2);
      await probe.operationalHeartbeat.deleteMany();assert.equal(await probe.operationalHeartbeat.count(),0);
      poolers.push({mode:pooler.mode,pgbouncerFlag:!pooler.prepared,maxPreparedStatements:pooler.prepared?100:0,clientConnections:clients.length,backendProcesses:pids.size,serverTlsVersion,checks:10,rowsRemaining:0});
    }finally{for(const probe of clients)await probe.$disconnect();}
  });
  await record("cleanup",async()=>{
    const finalState=await state();assert.deepEqual(finalState,baselineState);
    fs.writeFileSync(path.join(input.project,"final-state.json"),JSON.stringify(finalState));
  });
}finally{await client?.$disconnect();await admin.$disconnect();process.dlopen=dlopen;}
assert.deepEqual(checks,DATABASE_CHECKS);
const invocations=fs.readFileSync(path.join(input.project,"schema-engine-invocations.jsonl"),"utf8").trim().split("\n").map(JSON.parse);assert.ok(invocations.every(r=>r.sha256===input.schemaSha256));
for(const role of ["library","schema"])assert.equal(sha(input[role]),input[`${role}Sha256`]);
console.log(JSON.stringify({checks,sourceCommit:input.sourceCommit,librarySha256:input.librarySha256,schemaSha256:input.schemaSha256,loadedLibrarySha256:[...loaded][0],
  clientVersion:Prisma.prismaVersion.client,postgres,applicationInputSha256:hash(JSON.stringify(input.inputs)),migrationsApplied:input.inputs.filter(e=>e.path.endsWith("/migration.sql")).length,
  modelsChecked,rowsRemaining:0,seedRowsPreserved:3,baselineStateSha256:hash(JSON.stringify(baselineState)),existingHistoryUpgraded:true,schemaEngineInvocations:invocations.length,historyRegression,poolers,productionApproved:false,wholeEngineVerified:false}));
