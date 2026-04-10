const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotsDir = path.resolve(__dirname, '../../artifacts/screenshots');

(async () => {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3001';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${baseUrl}/reach`, { waitUntil: 'networkidle', timeout: 10000 });
  await page.waitForTimeout(1000);

  const results = [];
  const pass = (msg) => results.push('✅ ' + msg);
  const fail = (msg) => results.push('❌ ' + msg);

  // 1. Check Kết bạn switch is disabled
  try {
    const ketBanSwitch = await page.locator('text=Kết bạn').locator('..').locator('input[type="checkbox"]');
    const disabled = await ketBanSwitch.isDisabled();
    disabled ? pass('Kết bạn switch: disabled (no account)') : fail('Kết bạn switch: should be disabled');
  } catch(e) { fail('Kết bạn switch: ' + e.message.substring(0, 60)); }

  // 2. Check Nhắn tin switch toggles
  try {
    const nhanTinSwitch = await page.locator('text=Nhắn tin').first().locator('..').locator('input[type="checkbox"]');
    const before = await nhanTinSwitch.isChecked();
    await nhanTinSwitch.click({ force: true });
    const after = await nhanTinSwitch.isChecked();
    before !== after ? pass('Nhắn tin switch: toggles correctly') : fail('Nhắn tin switch: did not toggle');
    await nhanTinSwitch.click({ force: true }); // toggle back
  } catch(e) { fail('Nhắn tin switch: ' + e.message.substring(0, 60)); }

  // 3. Check Spam switch is on by default
  try {
    const spamSwitch = await page.locator('text=Spam').locator('..').locator('input[type="checkbox"]');
    const checked = await spamSwitch.isChecked();
    checked ? pass('Spam switch: ON by default') : fail('Spam switch: should be ON by default');
  } catch(e) { fail('Spam switch: ' + e.message.substring(0, 60)); }

  // 4. Check Bắt Đầu button exists and is clickable
  try {
    const btn = page.locator('button:has-text("Bắt Đầu")');
    await btn.waitFor({ state: 'visible', timeout: 2000 });
    const disabled = await btn.isDisabled();
    !disabled ? pass('Bắt Đầu button: visible and enabled') : fail('Bắt Đầu button: disabled');
  } catch(e) { fail('Bắt Đầu button: ' + e.message.substring(0, 60)); }

  // 5. Check AI viết lại buttons are disabled
  try {
    const aiButtons = page.locator('button:has-text("AI viết lại")');
    const count = await aiButtons.count();
    let allDisabled = true;
    for (let i = 0; i < count; i++) {
      if (!(await aiButtons.nth(i).isDisabled())) allDisabled = false;
    }
    allDisabled && count === 2 ? pass(`AI viết lại buttons: ${count} found, all disabled`) : fail(`AI viết lại buttons: ${count} found, allDisabled=${allDisabled}`);
  } catch(e) { fail('AI viết lại: ' + e.message.substring(0, 60)); }

  // 6. Check Tin nhắn nhanh button is disabled
  try {
    const btn = page.locator('button:has-text("Tin nhắn nhanh")');
    const disabled = await btn.isDisabled();
    disabled ? pass('Tin nhắn nhanh button: disabled') : fail('Tin nhắn nhanh button: should be disabled');
  } catch(e) { fail('Tin nhắn nhanh: ' + e.message.substring(0, 60)); }

  // 7. Check tabs switching
  try {
    const tabs = page.locator('[role="tab"]');
    const count = await tabs.count();
    const firstText = await tabs.first().textContent();
    await tabs.nth(1).click();
    const selected = await tabs.nth(1).getAttribute('aria-selected');
    selected === 'true' ? pass(`Tabs: ${count} tabs, switch works (Nhóm selected)`) : fail('Tabs: switch did not work');
    await tabs.first().click(); // switch back
  } catch(e) { fail('Tabs: ' + e.message.substring(0, 60)); }

  // 8. Check toggles in right column
  try {
    const xoaBanBe = page.locator('text=Xóa bạn bè').locator('..').locator('input[type="checkbox"]');
    await xoaBanBe.click({ force: true });
    const checked = await xoaBanBe.isChecked();
    checked ? pass('Xóa bạn bè toggle: works') : fail('Xóa bạn bè toggle: not working');
    await xoaBanBe.click({ force: true });
  } catch(e) { fail('Xóa bạn bè: ' + e.message.substring(0, 60)); }

  // 9. Check text input fields
  try {
    const delayFrom = page.locator('label:has-text("Từ (giây)")').locator('..').locator('input');
    const val = await delayFrom.inputValue();
    val === '60' ? pass('Từ (giây) input: default 60') : fail(`Từ (giây) input: ${val}`);
  } catch(e) { fail('Từ (giây): ' + e.message.substring(0, 60)); }

  // 10. Check search field
  try {
    const search = page.locator('input[placeholder="Tìm kiếm"]');
    await search.fill('test');
    const val = await search.inputValue();
    val === 'test' ? pass('Search input: works') : fail('Search input: value mismatch');
    await search.fill('');
  } catch(e) { fail('Search: ' + e.message.substring(0, 60)); }

  // 11. Check file input exists
  try {
    const fileInput = page.locator('input[type="file"]');
    const count = await fileInput.count();
    count > 0 ? pass('File input: exists (hidden)') : fail('File input: not found');
    const accept = await fileInput.getAttribute('accept');
    accept.includes('image') ? pass('File input: accepts images') : fail('File input: wrong accept');
  } catch(e) { fail('File input: ' + e.message.substring(0, 60)); }

  // 12. Check sidebar links
  try {
    const links = page.locator('a[href]');
    const count = await links.count();
    const hrefs = [];
    for (let i = 0; i < count; i++) {
      hrefs.push(await links.nth(i).getAttribute('href'));
    }
    const hasGuide = hrefs.some(h => h?.includes('doc.1man.io'));
    const hasFaq = hrefs.some(h => h?.includes('frequently-asked'));
    const hasSupport = hrefs.some(h => h?.includes('facebook.com'));
    hasGuide && hasFaq && hasSupport ? pass('Sidebar links: all 3 external links present') : fail(`Sidebar links: guide=${hasGuide} faq=${hasFaq} support=${hasSupport}`);
  } catch(e) { fail('Sidebar links: ' + e.message.substring(0, 60)); }

  // 13. Check sidebar collapse
  try {
    await page.locator('text=«').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(screenshotsDir, 'reach-sidebar-collapsed.png') });
    // Check text is hidden
    const tuongTac = page.locator('text=Tương Tác');
    const visible = await tuongTac.isVisible();
    !visible ? pass('Sidebar collapse: works (text hidden)') : fail('Sidebar collapse: text still visible');
    await page.locator('text=»').click();
    await page.waitForTimeout(500);
  } catch(e) { fail('Sidebar collapse: ' + e.message.substring(0, 60)); }

  // 14. Check Autocomplete for tag filter
  try {
    const combo = page.locator('[role="combobox"]').first();
    const exists = await combo.count();
    exists > 0 ? pass('Tag filter: Autocomplete/combobox present') : fail('Tag filter: no combobox found');
  } catch(e) { fail('Tag filter: ' + e.message.substring(0, 60)); }

  // 15. Check checkbox
  try {
    const cb = page.locator('[type="checkbox"]').first();
    await cb.click({ force: true });
    pass('Checkbox: clickable');
  } catch(e) { fail('Checkbox: ' + e.message.substring(0, 60)); }

  // 16. Check v4.0.7 button color is red
  try {
    const btn = page.locator('button:has-text("v4.0.7")');
    const color = await btn.evaluate(el => getComputedStyle(el).color);
    color.includes('255') && color.includes('72') ? pass('v4.0.7 button: red color') : fail(`v4.0.7 button: color=${color}`);
  } catch(e) { fail('v4.0.7: ' + e.message.substring(0, 60)); }

  // 17. Check Mua gói button
  try {
    const btn = page.locator('button:has-text("Mua gói")');
    const visible = await btn.isVisible();
    visible ? pass('Mua gói button: visible') : fail('Mua gói button: not visible');
  } catch(e) { fail('Mua gói: ' + e.message.substring(0, 60)); }

  // 18. Calendar button is disabled
  try {
    const calBtn = page.locator('button:has(svg)').filter({ has: page.locator('svg[data-testid="CalendarMonthIcon"]') }).first();
    const disabled = await calBtn.isDisabled();
    disabled ? pass('Calendar/Soon button: disabled') : fail('Calendar/Soon button: should be disabled');
  } catch(e) { fail('Calendar button: ' + e.message.substring(0, 60)); }

  // Print results
  console.log('\n=== FUNCTIONALITY TEST RESULTS ===\n');
  results.forEach(r => console.log(r));
  const passed = results.filter(r => r.startsWith('✅')).length;
  const failed = results.filter(r => r.startsWith('❌')).length;
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length} tests`);

  await browser.close();
})();
