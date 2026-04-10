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

    // Screenshot original
    let origPage = pages.find(p => p.url().includes('zalotool.net'));
    if (origPage) {
      await origPage.setViewportSize({ width: 1400, height: 900 });
      await origPage.screenshot({ path: path.join(screenshotsDir, 'reach-compare-original.png'), fullPage: false });
    }

    // Screenshot our version
    let ourPage = pages.find(p => p.url().includes('localhost:3000'));
    if (ourPage) {
      await ourPage.setViewportSize({ width: 1400, height: 900 });
      await ourPage.reload({ waitUntil: 'networkidle' });
      await ourPage.screenshot({ path: path.join(screenshotsDir, 'reach-compare-local.png'), fullPage: false });
    }

    // Detailed differences check
    if (origPage) {
      const origDetails = await origPage.evaluate(() => {
        const results = {};

        // 1. Sidebar collapse button style
        const collapseBtn = document.querySelector('[class*="MuiDrawer"] button, [class*="MuiDrawer"] [role="button"]');
        results.collapseBtn = collapseBtn ? {
          text: collapseBtn.textContent?.trim(),
          style: {
            position: getComputedStyle(collapseBtn).position,
          }
        } : 'not found';

        // 2. "Tài khoản:" section - icon sizes
        const allText = document.body.innerText;
        const hasAccountAdd = allText.includes('Tài khoản:');
        results.accountSection = hasAccountAdd;

        // 3. Kết bạn typography
        const ketBanEl = Array.from(document.querySelectorAll('*')).find(el => 
          el.textContent?.trim() === 'Kết bạn' && el.children.length === 0
        );
        if (ketBanEl) {
          const s = getComputedStyle(ketBanEl);
          results.ketBanStyle = {
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
            tag: ketBanEl.tagName,
          };
        }

        // 4. Nhắn tin typography
        const nhanTinEl = Array.from(document.querySelectorAll('*')).find(el => 
          el.textContent?.trim() === 'Nhắn tin' && el.children.length === 0
        );
        if (nhanTinEl) {
          const s = getComputedStyle(nhanTinEl);
          results.nhanTinStyle = {
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
          };
        }

        // 5. "Cách nhau:" layout
        const cachNhau = Array.from(document.querySelectorAll('*')).find(el => 
          el.textContent?.trim().startsWith('Cách nhau') && el.children.length === 0
        );
        if (cachNhau) {
          results.cachNhauStyle = {
            fontSize: getComputedStyle(cachNhau).fontSize,
            fontWeight: getComputedStyle(cachNhau).fontWeight,
          };
        }

        // 6. Spam switch - red color
        const spamSwitch = Array.from(document.querySelectorAll('[class*="MuiSwitch"]')).find(s => {
          const p = s.closest('div');
          return p?.textContent?.includes('Spam');
        });
        if (spamSwitch) {
          const track = spamSwitch.querySelector('[class*="MuiSwitch-track"]');
          results.spamSwitchColor = track ? getComputedStyle(track).backgroundColor : 'no track';
        }

        // 7. "Không có dữ liệu" image
        const emptyImg = document.querySelector('img[alt*="empty"], img[src*="illustration"]');
        results.emptyImage = emptyImg ? { src: emptyImg.src?.substring(0, 100), width: emptyImg.offsetWidth } : 'not found';

        // 8. Attachment section image
        const attachArea = Array.from(document.querySelectorAll('img')).find(img => 
          img.closest('div')?.textContent?.includes('Ảnh/Video/File')
        );
        results.attachImage = attachArea ? { src: attachArea.src?.substring(0, 120), width: attachArea.offsetWidth } : 'not found';

        // 9. Table area
        const tableEl = document.querySelector('table');
        results.tableInfo = tableEl ? {
          headerCells: Array.from(tableEl.querySelectorAll('th')).map(th => th.textContent?.trim()),
          hasSortIcon: !!tableEl.querySelector('[class*="sort"], [data-testid*="sort"]'),
          width: tableEl.offsetWidth,
        } : 'no table';

        // 10. "Bộ sưu tập" position relative to other elements
        const boSuuTap = Array.from(document.querySelectorAll('*')).find(el =>
          el.textContent?.trim().startsWith('Bộ sưu tập') && el.children.length <= 3
        );
        if (boSuuTap) {
          const r = boSuuTap.getBoundingClientRect();
          results.boSuuTapPos = { top: r.top, left: r.left };
        }

        // 11. Account + / Settings icons
        const accountRow = Array.from(document.querySelectorAll('*')).find(el =>
          el.textContent?.trim().startsWith('Tài khoản:') && el.children.length >= 1
        );
        if (accountRow) {
          const icons = accountRow.querySelectorAll('svg, [class*="Icon"]');
          results.accountIcons = icons.length;
          const r = accountRow.getBoundingClientRect();
          results.accountPos = { top: r.top, left: r.left };
        }

        // 12. "Soon" chip position
        const soonChip = Array.from(document.querySelectorAll('*')).find(el =>
          el.textContent?.trim() === 'Soon'
        );
        if (soonChip) {
          const r = soonChip.getBoundingClientRect();
          results.soonPos = { top: r.top, left: r.left, fontSize: getComputedStyle(soonChip).fontSize };
        }

        // 13. "Lọc tài khoản" select - we might have missed this
        const locTK = Array.from(document.querySelectorAll('label, [class*="MuiInputLabel"]')).find(el =>
          el.textContent?.includes('Lọc tài khoản')
        );
        results.hasLocTaiKhoan = !!locTK;

        return results;
      });

      console.log('\n====== DETAILED COMPARISON ======');
      console.log(JSON.stringify(origDetails, null, 2));
    }

    console.log('\nDone!');
  } catch (e) {
    console.error('Error:', e.message);
  }
})();
