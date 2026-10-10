import { expect,test } from '@playwright/test';
import { composerFixture } from './composer-fixture';
test('ctrl_shift_n_opens_independent_windows_and_workspace_drafts_stay_local',async({page,context})=>{
 await composerFixture(page,{windowId:'main'});await page.goto('/');
 await page.getByLabel('النص أو الوصف',{exact:true}).fill('مسودة الأولى');
 await page.keyboard.press('Control+Shift+N');
 await expect.poll(()=>page.evaluate(()=>(globalThis as any).__MAWJIVO_TEST__.calls.filter((c:any)=>c.command==='open_composer_window').length)).toBe(1);
 const second=await context.newPage();await composerFixture(second,{windowId:'composer-second'});await second.goto('/');
 await second.getByLabel('النص أو الوصف',{exact:true}).fill('مسودة الثانية');
 await page.getByLabel('مساحة العمل',{exact:true}).selectOption('space-b');
 await expect(second.getByLabel('مساحة العمل',{exact:true})).toHaveValue('space-a');
 await page.getByLabel('مساحة العمل',{exact:true}).selectOption('space-a');
 await expect(page.getByLabel('النص أو الوصف',{exact:true})).toHaveValue('مسودة الأولى');
 await expect(second.getByLabel('النص أو الوصف',{exact:true})).toHaveValue('مسودة الثانية');
 const ids=await Promise.all([page,second].map(p=>p.evaluate(()=>(globalThis as any).__MAWJIVO_TEST__.drafts.get('space-a')?.id)));
 expect(ids[0]).toBeTruthy();expect(ids[1]).toBeTruthy();expect(ids[0]).not.toBe(ids[1]);
});
