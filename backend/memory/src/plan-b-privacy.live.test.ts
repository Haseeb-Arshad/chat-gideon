import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {applyMigrations} from './migrations.ts'
const enabled=process.env.GIDEON_MEMORY_POSTGRES_TEST==='1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)
describe.skipIf(!enabled)('Plan B private tables under Supabase-style creation grants',()=>{
  const pool=new Pool({connectionString:process.env.MEMORY_TEST_DATABASE_URL,max:1})
  beforeAll(async()=>{
    if(process.env.MEMORY_TEST_DATABASE_OWNED!=='1')throw new Error('Use an owned disposable database')
    await pool.query(`DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',r); END IF; END LOOP; END $$`)
    await pool.query('DROP SCHEMA IF EXISTS gideon_memory CASCADE')
    await pool.query('ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role')
    await applyMigrations(pool)
  })
  afterAll(async()=>{
    await pool.query('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM anon,authenticated,service_role')
    await pool.end()
  })
  it('removes direct API grants and enables row-level security on all five derivative tables',async()=>{
    for(const table of ['turn_traces','knowledge_gaps','skill_overlays','maintenance_dispatch','embedding_exclusions']){
      const security=await pool.query<{relrowsecurity:boolean}>('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[`gideon_memory.${table}`])
      expect(security.rows[0].relrowsecurity).toBe(true)
      for(const role of ['anon','authenticated','service_role']){
        const result=await pool.query<{allowed:boolean}>('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,`gideon_memory.${table}`,'SELECT,INSERT,UPDATE,DELETE'])
        expect(result.rows[0].allowed).toBe(false)
      }
    }
  })
})
