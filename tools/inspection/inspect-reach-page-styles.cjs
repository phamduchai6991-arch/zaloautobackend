const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const pages = context.pages();

    let origPage = pages.find(p => p.url().includes('zalotool.net'));
    if (!origPage) { console.log('No zalotool page found'); return; }

    const origDetails = await origPage.evaluate(() => {
      const results = {};

      // Kết bạn typography
      const ketBanEl = Array.from(document.querySelectorAll('*')).find(el => 
        el.textContent?.trim() === 'Kết bạn' && el.children.length === 0
      );
      if (ketBanEl) {
        const s = getComputedStyle(ketBanEl);
        results.ketBanStyle = { fontSize: s.fontSize, fontWeight: s.fontWeight };
      }

      // Cách nhau typography
      const cachNhau = Array.from(document.querySelectorAll('*')).find(el => 
        el.textContent?.trim().startsWith('Cách nhau') && el.children.length === 0
      );
      if (cachNhau) {
        results.cachNhauStyle = { fontSize: getComputedStyle(cachNhau).fontSize, fontWeight: getComputedStyle(cachNhau).fontWeight };
      }

      // Spam switch track color
      const allSwitches = document.querySelectorAll('[class*="MuiSwitch-root"]');
      allSwitches.forEach((s, i) => {
        const track = s.querySelector('[class*="MuiSwitch-track"]');
        const input = s.querySelector('input');
        if (track && input?.checked) {
          results[`switch_${i}_checked_trackColor`] = getComputedStyle(track).backgroundColor;
        }
      });

      // Attachment illustration - src
      const imgs = document.querySelectorAll('img');
      imgs.forEach(img => {
        if (img.src?.includes('illustration') || img.src?.includes('upload') || img.src?.includes('file')) {
          results.attachImageSrc = img.src;
        }
        if (img.src?.includes('empty') || img.src?.includes('illustration_empty')) {
          results.emptyImageSrc = img.src;
        }
      });

      // "Lọc tài khoản" field - check if exists
      const locTK = Array.from(document.querySelectorAll('label')).find(el => el.textContent?.includes('Lọc tài khoản'));
      results.hasLocTaiKhoan = !!locTK;

      // Sidebar main section items - check for sub-items under Tương tác
      const drawer = document.querySelector('[class*="MuiDrawer-paper"]');
      if (drawer) {
        const allItems = drawer.querySelectorAll('[class*="MuiListItem"], [class*="MuiButtonBase"]');
        results.sidebarItemCount = allItems.length;

        // Check if "Tương Tác" has sub-items
        const tuongTac = Array.from(allItems).find(i => i.textContent?.includes('Tương'));
        results.tuongTacHasChildren = tuongTac ? tuongTac.querySelectorAll('[class*="MuiListItem"]').length : 0;
      }

      // The content between "Đã đăng:" and "Kết bạn" - there might be a divider or Lọc tài khoản
      const fullText = document.querySelector('main')?.innerText || '';
      const daDangIdx = fullText.indexOf('Đã đăng:');
      const ketBanIdx = fullText.indexOf('Kết bạn');
      if (daDangIdx >= 0 && ketBanIdx >= 0) {
        results.betweenDaDangAndKetBan = fullText.substring(daDangIdx, ketBanIdx + 10).replace(/\n/g, ' | ');
      }

      // Check if there's a "Lọc tài khoản" input/select in the left column
      const mainEl = document.querySelector('main');
      const grids = mainEl?.querySelectorAll('[class*="MuiGrid-item"]');
      if (grids?.[0]) {
        const leftText = grids[0].innerText;
        results.leftColHasLocTaiKhoan = leftText.includes('Lọc tài khoản');
      }

      // The exact order of controls in the bottom of left column
      const bottomControls = fullText.match(/Cách nhau[\s\S]*?Soon/)?.[0]?.replace(/\n/g, ' | ');
      results.bottomControlsOrder = bottomControls?.substring(0, 200);

      // "Tin nhắn:" icons - what icons are next to it
      const tinNhan = Array.from(document.querySelectorAll('*')).find(el =>
        el.textContent?.trim() === 'Tin nhắn:' && el.children.length === 0
      );
      if (tinNhan) {
        const parent = tinNhan.parentElement;
        const siblings = parent?.querySelectorAll('svg, [class*="Icon"], button');
        results.tinNhanIcons = siblings?.length || 0;
      }

      return results;
    });

    console.log(JSON.stringify(origDetails, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }
})();
