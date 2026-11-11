"""Tests UI sans accès à Supabase : serveur statique et réponses simulées, aucune écriture distante."""
from pathlib import Path
from threading import Thread
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[2]
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
Thread(target=server.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{server.server_port}'
MOCK = r"""
window.calls=[];
const user={id:'person',email:'test@example.invalid'};
const profile={first_name:'Personne',last_name:'Fictive',role:'clinician',institution:'CHUV',lang:'fr'};
window.clinicState={editable:true,initial:INITIAL,clinics:INITIAL?[]:['Thoracique'],options:['Thoracique','Urologie'],changes:[]};
const sb={
 auth:{getSession:async()=>({data:{session:{user}}}),updateUser:async()=>({error:null}),signOut:async()=>({error:null})},
 from:()=>{const q={select:()=>q,eq:()=>q,update:()=>q,single:async()=>({data:profile}),then:(resolve)=>Promise.resolve({data:profile,error:null}).then(resolve)};return q;},
 rpc:async(name,args)=>{
  window.calls.push({name,args});
  let data=[];
  if(name==='my_clinics') data=structuredClone(window.clinicState);
  if(name==='my_set_clinics') {if(window.clinicState.initial){window.clinicState.initial=false;window.clinicState.clinics=args.p_clinics;}else window.clinicState.pending={id:1,clinics:args.p_clinics};data=args.p_clinics;}
  if(name==='my_absence_visibility')data={editable:false};
  if(name==='current_role_name')data='admin';
  if(name==='admin_members')data=[];
  if(name==='admin_clinic_requests')data=window.requestDone?[]:[{id:1,user_id:'other',name:'Médecin fictif',current:['Thoracique'],clinics:['Urologie']}];
  if(name==='admin_clinic_request_decide'){window.requestDone=true;data=null;}
  if(name==='absence_context')data={me:'person',role:'clinician',clinics:['Thoracique'],validates:[],pending:0};
  if(name==='absence_people')data=[{id:'person',name:'Personne Fictive',role:'clinician',clinics:['Thoracique'],is_me:true}];
  if(name==='absence_list')data=[{id:42,user_id:'person',kind:'vacances',status:'approved',start_date:'2027-02-01',end_date:'2027-02-02',submitted_at:'2026-11-11T10:00:00Z'}];
  if(name==='absence_history')data=[{entity:'absences',action:'UPDATE',actor_name:'Direction fictive',at:'2026-11-11T10:00:00Z',before_data:{start_date:'2027-01-01',end_date:'2027-01-02'},after_data:{id:42,start_date:'2027-02-01',end_date:'2027-02-02'}}];
  if(name==='absence_document_versions')data=[{id:99,action:'modified',at:'2026-11-11T10:00:00Z'}];
  if(name==='absence_notification_status')data={pending:1,failed:0,sent:2};
  if(name==='absence_balance')data={year:2027,vacation:{allowance:25,used:2,remaining:23},congress:{allowance:3,used:0,remaining:3}};
  return {data,error:null};
 },functions:{invoke:async(name,args)=>{window.calls.push({name,args});return {data:{file:'test.pdf',pdf:btoa('%PDF-test')},error:null};}}
};
window.supabase={createClient:()=>sb};
"""
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  for initial in [True,False]:
   context=browser.new_context(viewport={'width':390,'height':844})
   context.add_init_script(MOCK.replace('INITIAL','true' if initial else 'false'))
   context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(BASE+'/fr/app/compte.html')
   expect(page.locator('#clinics')).to_be_visible()
   page.locator('#clinics-list input[value="Urologie"]').check()
   page.locator('#clinics-form button').click()
   expect(page.locator('#clinics-msg')).to_contain_text('Cliniques enregistrées' if initial else 'Vos cliniques actuelles restent en vigueur')
   if not initial:
    assert page.evaluate('window.clinicState.clinics')==['Thoracique']
   assert not errors,errors
   context.close()
  context=browser.new_context()
  context.add_init_script(MOCK.replace('INITIAL','true'))
  context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(BASE) else r.abort())
  page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(BASE+'/fr/bienvenue.html')
  expect(page.locator('fieldset legend').filter(has_text='Mes cliniques')).to_be_visible()
  page.locator('fieldset input[value="Thoracique"]').check()
  page.locator('#welcome-form input[name="password"]').fill('Fictif-MotDePasse-2026')
  page.locator('#welcome-form input[name="confirm"]').fill('Fictif-MotDePasse-2026')
  page.locator('#welcome-form button[type="submit"]').click()
  expect(page.locator('#welcome-msg')).to_contain_text('Bienvenue')
  assert page.evaluate('window.calls.some(c=>c.name==="my_set_clinics" && c.args.p_clinics.includes("Thoracique"))')
  page.goto(BASE+'/admin/membres.html')
  expect(page.locator('#am-clinic-requests')).to_contain_text('Médecin fictif')
  page.locator('#am-clinic-requests button').filter(has_text='Accepter').click()
  expect(page.locator('#am-clinic-requests')).to_contain_text('Aucune demande en attente')
  page.goto(BASE+'/app/absences.html#mine')
  expect(page.locator('#ab-notifications')).to_contain_text('1 en attente')
  details=page.locator('details').filter(has=page.locator('summary',has_text='Historique et versions des documents'))
  details.locator('summary').click()
  expect(details).to_contain_text('Direction fictive')
  expect(details).to_contain_text('Rectificatif D99')
  details.get_by_role('button',name='Rectificatif D99',exact=False).click()
  page.wait_for_function('window.calls.some(c=>c.name==="notify-absence" && c.args.body.document_id===99)')
  assert not errors,errors
  browser.close()
 print('Chromium : choix initial et modification du compte, première connexion, validation admin, historique et téléchargement de version OK')
finally:
 server.shutdown()
