const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotsDir = path.resolve(__dirname, '../../artifacts/screenshots');

(async () => {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  // Connect to existing Chrome via CDP
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();
  
  // Find the zalotool tab
  let page = pages.find(p => p.url().includes('zalotool'));
  if (!page) {
    page = pages[0];
    await page.goto('https://zalotool.net/reach');
  }

  console.log('=== CURRENT URL ===');
  console.log(page.url());

  // Wait for the page to be fully loaded
  await page.waitForLoadState('networkidle');

  // Get the full page HTML structure
  const bodyHTML = await page.evaluate(() => {
    function getStructure(el, depth = 0) {
      if (depth > 6) return '';
      const indent = '  '.repeat(depth);
      let result = '';
      
      for (const child of el.children) {
        const tag = child.tagName.toLowerCase();
        const classes = child.className && typeof child.className === 'string' ? child.className.split(' ').filter(c => c && !c.startsWith('css-')).join('.') : '';
        const text = child.childNodes.length === 1 && child.childNodes[0].nodeType === 3 
          ? child.textContent.trim().substring(0, 80) : '';
        const role = child.getAttribute('role') || '';
        const ariaLabel = child.getAttribute('aria-label') || '';
        const placeholder = child.getAttribute('placeholder') || '';
        const type = child.getAttribute('type') || '';
        
        let info = `${indent}<${tag}`;
        if (classes) info += ` class="${classes}"`;
        if (role) info += ` role="${role}"`;
        if (ariaLabel) info += ` aria-label="${ariaLabel}"`;
        if (placeholder) info += ` placeholder="${placeholder}"`;
        if (type) info += ` type="${type}"`;
        if (text) info += ` > "${text}"`;
        else info += '>';
        
        result += info + '\n';
        result += getStructure(child, depth + 1);
      }
      return result;
    }
    return getStructure(document.body);
  });

  console.log('\n=== PAGE STRUCTURE ===');
  console.log(bodyHTML);

  // Get all visible text content organized by sections
  const textContent = await page.evaluate(() => {
    const sections = document.querySelectorAll('[class*="MuiPaper"], [class*="MuiCard"], [class*="MuiBox"], [role="tablist"], [role="tab"], nav, aside, header');
    const results = [];
    const seen = new Set();
    
    sections.forEach(s => {
      const text = s.innerText?.trim();
      if (text && text.length > 5 && !seen.has(text.substring(0, 50))) {
        seen.add(text.substring(0, 50));
        results.push({
          tag: s.tagName,
          role: s.getAttribute('role'),
          text: text.substring(0, 500)
        });
      }
    });
    return results;
  });

  console.log('\n=== SECTIONS TEXT ===');
  textContent.forEach((s, i) => {
    console.log(`\n--- Section ${i + 1} (${s.tag} role=${s.role}) ---`);
    console.log(s.text);
  });

  // Get all buttons, inputs, selects
  const interactiveElements = await page.evaluate(() => {
    const elements = document.querySelectorAll('button, input, select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="switch"]');
    return Array.from(elements).map(el => ({
      tag: el.tagName,
      type: el.type || el.getAttribute('role'),
      text: el.innerText?.trim().substring(0, 100) || el.getAttribute('aria-label') || el.placeholder || '',
      checked: el.checked,
      value: el.value?.substring(0, 50),
      disabled: el.disabled
    }));
  });

  console.log('\n=== INTERACTIVE ELEMENTS ===');
  interactiveElements.forEach((el, i) => {
    console.log(`${i + 1}. <${el.tag}> type=${el.type} text="${el.text}" value="${el.value || ''}" checked=${el.checked} disabled=${el.disabled}`);
  });

  // Take a screenshot
  const screenshotPath = path.join(screenshotsDir, 'reach-original-page-full.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`\n=== Screenshot saved as ${screenshotPath} ===`);

  // Don't close the browser - user is still using it
})();
