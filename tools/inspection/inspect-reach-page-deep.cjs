const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotsDir = path.resolve(__dirname, '../../artifacts/screenshots');

(async () => {
  try {
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const pages = context.pages();
    
    // Find zalotool tab
    let page = pages.find(p => p.url().includes('zalotool.net'));
    if (!page) {
      page = await context.newPage();
      await page.goto('https://zalotool.net/reach', { waitUntil: 'networkidle', timeout: 30000 });
    }

    console.log('URL:', page.url());

    // ====== 1. HEADER ======
    const header = await page.evaluate(() => {
      const h = document.querySelector('header');
      if (!h) return 'No header';
      const btns = h.querySelectorAll('button');
      const chips = [];
      btns.forEach(b => {
        const t = b.textContent?.trim();
        if (t) chips.push(t);
      });
      // avatar section
      const avatars = h.querySelectorAll('[class*="MuiAvatar"], img[alt]');
      const avatarInfo = Array.from(avatars).map(a => ({
        alt: a.alt, src: a.src?.substring(0, 80), text: a.textContent?.trim()
      }));
      return { buttons: chips, avatars: avatarInfo, fullText: h.innerText?.substring(0, 300) };
    });
    console.log('\n====== 1. HEADER ======');
    console.log(JSON.stringify(header, null, 2));

    // ====== 2. SIDEBAR ======
    const sidebar = await page.evaluate(() => {
      const drawer = document.querySelector('[class*="MuiDrawer-paper"]');
      if (!drawer) return 'No drawer';
      const items = drawer.querySelectorAll('[class*="MuiListItemButton"], [class*="MuiButtonBase"], a');
      const navItems = [];
      const seen = new Set();
      items.forEach(item => {
        const text = item.textContent?.trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          const icon = item.querySelector('svg');
          const isActive = item.className?.includes('Mui-selected') || 
            getComputedStyle(item).backgroundColor !== 'rgba(0, 0, 0, 0)';
          navItems.push({ text, hasIcon: !!icon, active: isActive });
        }
      });
      const version = drawer.innerText?.match(/build\.[.\d]+/)?.[0] || '';
      return { navItems, version, fullText: drawer.innerText?.substring(0, 500) };
    });
    console.log('\n====== 2. SIDEBAR ======');
    console.log(JSON.stringify(sidebar, null, 2));

    // ====== 3. LEFT COLUMN - Account section ======
    const leftCol = await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return 'No main';
      const grids = main.querySelectorAll('[class*="MuiGrid-item"]');
      if (grids.length < 1) return 'No grids found - text: ' + main.innerText?.substring(0, 200);
      const left = grids[0];
      
      // Account section
      const accountText = left.innerText?.substring(0, 100);
      
      // All switches in left column
      const switches = left.querySelectorAll('[class*="MuiSwitch"]');
      const switchLabels = [];
      switches.forEach(s => {
        const container = s.closest('[class*="MuiBox"], [class*="MuiStack"], div');
        const prevText = container?.querySelector('h6, h5, [class*="Typography"]')?.textContent?.trim() || '';
        const input = s.querySelector('input');
        switchLabels.push({ label: prevText, checked: input?.checked });
      });

      // All textareas
      const textareas = left.querySelectorAll('textarea');
      const taInfo = Array.from(textareas).map(t => ({
        placeholder: t.placeholder,
        rows: t.rows,
        value: t.value?.substring(0, 50),
        parentText: t.closest('[class*="MuiPaper"], [class*="MuiBox"]')?.querySelector('[class*="Typography"]')?.textContent?.trim()
      }));

      // Buttons
      const buttons = left.querySelectorAll('button');
      const btnInfo = Array.from(buttons).map(b => ({
        text: b.textContent?.trim().substring(0, 50),
        disabled: b.disabled,
        variant: b.className?.includes('contained') ? 'contained' : b.className?.includes('outlined') ? 'outlined' : 'text',
        color: getComputedStyle(b).backgroundColor
      })).filter(b => b.text);

      // Input fields (text/number)
      const inputs = left.querySelectorAll('input[type="text"], input[type="number"]');
      const inputInfo = Array.from(inputs).map(i => ({
        type: i.type,
        value: i.value,
        label: i.closest('[class*="MuiFormControl"]')?.querySelector('label')?.textContent?.trim() || ''
      }));

      return { 
        fullText: left.innerText?.substring(0, 1500),
        switches: switchLabels, 
        textareas: taInfo, 
        buttons: btnInfo,
        inputs: inputInfo
      };
    });
    console.log('\n====== 3. LEFT COLUMN ======');
    console.log(JSON.stringify(leftCol, null, 2));

    // ====== 4. RIGHT COLUMN ======
    const rightCol = await page.evaluate(() => {
      const main = document.querySelector('main');
      const grids = main?.querySelectorAll('[class*="MuiGrid-item"]');
      if (!grids || grids.length < 2) return 'No right column';
      const right = grids[1];

      // All switches
      const switches = right.querySelectorAll('[class*="MuiSwitch"]');
      const switchInfo = [];
      switches.forEach(s => {
        const parent = s.parentElement?.parentElement || s.parentElement;
        let labelText = '';
        let el = s;
        while (el && !labelText) {
          el = el.previousElementSibling;
          if (el) labelText = el.textContent?.trim();
        }
        if (!labelText) {
          const p = s.closest('div');
          labelText = p?.childNodes?.[0]?.textContent?.trim() || '';
        }
        const input = s.querySelector('input');
        switchInfo.push({ label: labelText, checked: input?.checked });
      });

      // Tabs
      const tabs = right.querySelectorAll('[role="tab"]');
      const tabInfo = Array.from(tabs).map(t => ({
        text: t.textContent?.trim(),
        selected: t.getAttribute('aria-selected') === 'true'
      }));

      // Select/dropdown
      const selects = right.querySelectorAll('[class*="MuiSelect"], select, [role="combobox"]');
      const selectInfo = Array.from(selects).map(s => ({
        text: s.textContent?.trim().substring(0, 50),
        value: s.value,
      }));

      // Table headers
      const thCells = right.querySelectorAll('th, [class*="MuiTableCell-head"]');
      const headers = Array.from(thCells).map(th => th.textContent?.trim());

      // Checkbox
      const checkboxes = right.querySelectorAll('[class*="MuiCheckbox"]');
      
      return {
        fullText: right.innerText?.substring(0, 1500),
        switches: switchInfo,
        tabs: tabInfo,
        selects: selectInfo,
        tableHeaders: headers,
        checkboxCount: checkboxes.length,
      };
    });
    console.log('\n====== 4. RIGHT COLUMN ======');
    console.log(JSON.stringify(rightCol, null, 2));

    // ====== 5. CSS / Styling Details ======
    const styles = await page.evaluate(() => {
      const main = document.querySelector('main');
      const bg = getComputedStyle(document.body).backgroundColor;
      const mainBg = main ? getComputedStyle(main).backgroundColor : '';
      
      // Header height
      const header = document.querySelector('header');
      const headerH = header?.offsetHeight;
      
      // Sidebar width
      const drawer = document.querySelector('[class*="MuiDrawer-paper"]');
      const drawerW = drawer?.offsetWidth;
      
      // Button "Bắt Đầu" style
      const startBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Bắt'));
      const startBtnStyle = startBtn ? {
        bg: getComputedStyle(startBtn).backgroundColor,
        color: getComputedStyle(startBtn).color,
        borderRadius: getComputedStyle(startBtn).borderRadius,
        padding: getComputedStyle(startBtn).padding,
        fontSize: getComputedStyle(startBtn).fontSize,
        width: startBtn.offsetWidth,
        height: startBtn.offsetHeight,
      } : null;

      // "AI viết lại" button style
      const aiBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('AI viết'));
      const aiBtnStyle = aiBtn ? {
        bg: getComputedStyle(aiBtn).backgroundColor,
        border: getComputedStyle(aiBtn).border,
        borderRadius: getComputedStyle(aiBtn).borderRadius,
        color: getComputedStyle(aiBtn).color,
      } : null;

      return { bodyBg: bg, mainBg, headerHeight: headerH, drawerWidth: drawerW, startBtnStyle, aiBtnStyle };
    });
    console.log('\n====== 5. STYLES ======');
    console.log(JSON.stringify(styles, null, 2));

    // ====== 6. Full page screenshot for reference  ======
    await page.setViewportSize({ width: 1400, height: 900 });
    const screenshotPath = path.join(screenshotsDir, 'reach-original-full.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`\nScreenshot saved: ${screenshotPath}`);

    // ====== 7. Detailed element positions ======
    const positions = await page.evaluate(() => {
      const elMap = {};
      // Key elements to track
      const selectors = {
        'header': 'header',
        'sidebar': '[class*="MuiDrawer-paper"]',
        'main': 'main',
        'startButton': 'button',
      };
      for (const [name, sel] of Object.entries(selectors)) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          elMap[name] = { top: r.top, left: r.left, width: r.width, height: r.height };
        }
      }
      return elMap;
    });
    console.log('\n====== 7. ELEMENT POSITIONS ======');
    console.log(JSON.stringify(positions, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
  }
})();
