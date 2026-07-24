import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

const globalStyles = `
* { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Century Gothic, CenturyGothic, AppleGothic, sans-serif; background: #f5f5f5; color: #222; min-height: 100vh; }
  a { color: inherit; text-decoration: none; }
  input, select, textarea, button { font-family: Century Gothic, CenturyGothic, AppleGothic, sans-serif; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: #f0f0f0; }
  ::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }

  .layout { display: flex; min-height: 100vh; background: #ffffff;}

   .sidebar {
    width: 300px; min-width: 200px; background: #fff;
    border-right: 1px solid #e8e8e8; padding: 24px 0;
    position: sticky; top: 0; height: 100vh; overflow-y: auto; flex-shrink: 0;
  }
  .sidebar-group-label {
    padding: 16px 24px 6px;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: #CC9F53;
    text-transform: uppercase;
  }
  .sidebar-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 13px 24px;
    font-size: 14px;
    color: #5C5D60;
    text-decoration: none;
    font-weight: 400;
}
 .sidebar-link.active {
    color: #000000;
    background: #fdf8ee;
    border-left: 2px solid #C8A951;
}
   .sidebar-link .plus { color: #ccc; font-size: 10px; }
  .sidebar-link-num { color: #CC9F53; font-weight: 700; padding-right: 15px; font-size: 14px; }

  .mobile-tabs {
    display: none; overflow-x: auto; white-space: nowrap;
    background: #fff; border-bottom: 1px solid #e8e8e8;
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    -webkit-overflow-scrolling: touch;
  }
  .mobile-tabs::-webkit-scrollbar { display: none; }
  .mobile-tab {
    display: inline-flex; flex-direction: column; align-items: center;
    padding: 10px 18px 0; cursor: pointer; border-bottom: 3px solid transparent;
    text-decoration: none; gap: 2px;
  }
  .mobile-tab.active { border-bottom-color: #B8860B; }
  .mobile-tab .tab-num { font-size: 11px; font-weight: 700; color: #B8860B; letter-spacing: 0.04em; }
  .mobile-tab .tab-label { font-size: 11px; font-weight: 700; color: #111; letter-spacing: 0.06em; text-transform: uppercase; padding-bottom: 8px; }

  .main { flex: 1; padding: 50px 80px 60px; max-width: 860px; background: #fff; }

  .section-heading {
    display: flex;
    align-items: center;
    gap: 5px;
    padding-bottom: 20px;
    border-bottom: 1px solid #E8E6E0;
    margin-bottom: 30px;
}
  .section-num {
    font-size: 24px;
    font-weight: 700;
    color: #CC9F53;
    letter-spacing: 0.06em;
  }
  .section-title { font-size: 24px; font-weight: 700; color: #222; letter-spacing: 0.06em; text-transform: uppercase; }
  .section-divider { border: none; border-top: 1px solid #e8e8e8; margin: 12px 0 20px; display: none; }

  .field-group { margin-bottom: 10px; }
.field-label {
    font-size: 14px;
    font-weight: 700;
    color: #333;
    margin-bottom: 5px;
    line-height: 22px;
    display: flex;
    gap: 5px;
    align-items: center;
}
  .req {
    color: #CC9F53;
    font-size: 12px;
}
 .field-hint {
    font-size: 12px;
    color: #666666;
    margin-bottom: 5px;
}
 .field-input {
    width: 100%;
    padding: 10px 12px;
    border: 0;
    border-radius: 2px;
    font-size: 13px;
    color: #333;
    background: #F8F8F9;
    outline: none;
}
  .field-input:focus { border-color: #B8860B; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }

.count-show {
    color: #666666;
    font-size: 12px;
    position: absolute;
    right: 12px;
    bottom: 8px;
}

.field-group.setup {
    border: 1px solid #E3D0A6;
}
  .upload-box {
    border: 1px dashed #ccc;
    background: #F8F8F9;
    min-height: 140px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 40px;
}

 label.picture-radio {
    background: #F8F8F9;
    padding: 12px 16px;
    color: #000000 !important;
    font-size: 14px;
}

label.picture-radio input[type='radio'] {
    width: 16px;
    height: 16px;
}
   
select.field-input {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  color: #333;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='7' viewBox='0 0 10 7' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M9.29023 0.296501C9.78106 0.729587 9.82787 1.47857 9.39478 1.9694L6.3453 5.42548C5.54911 6.32783 4.14213 6.32783 3.34595 5.42548L0.29646 1.9694C-0.136626 1.47857 -0.0898143 0.729587 0.401017 0.296501C0.891849 -0.136585 1.64083 -0.0897736 2.07392 0.401058L4.84562 3.54232L7.61732 0.401059C8.05041 -0.0897726 8.79939 -0.136585 9.29023 0.296501Z' fill='%23000000'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 14px center;
  background-size: 10px 7px;
  padding-right: 36px;
}

  .upload-icon {
    display: flex; align-items: center; justify-content: center;
    color: #ccc; font-size: 18px; margin-bottom: 10px;
  }
  .upload-link {
    color: #C8A951;
    text-decoration: underline;
    cursor: pointer;
    font-size: 14px;
    font-weight: 700;
}

input.field-input {
    background: #F8F8F9;
    border: 1px solid #F8F8F9 !important;
    border-radius: 5px;
    padding: 12px 16px !important;
}

  .list-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid #f0f0f0; }
  .list-thumb {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #F5F4F0;
    flex-shrink: 0;
    border: 1px solid #E8E6E0;
}
  .list-footer { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: #ffffff; border-top: 1px solid #f0f0f0; }

  .submit-btn {
    background: #CC9F53;
    color: #000000;
    border: none;
    padding: 12px 36px;
    border-radius: 35px;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.04em;
    cursor: pointer;
    text-transform: uppercase;
}
  .submit-btn:hover { background: #9a7009; }

  @media (max-width: 768px) {
    .sidebar { display: none; }
    .mobile-tabs { display: block; }
    .layout { flex-direction: column; }
    .main { padding: 80px 20px 60px; max-width: 100%; }
    .field-row { grid-template-columns: 1fr; }
    .section-heading { gap: 12px; margin-bottom: 8px; }
    .section-num { font-size: 36px; font-weight: 700; line-height: 1; }
    .section-title { font-size: 18px; font-weight: 700; }
    .field-label { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
    .field-hint { font-size: 13px; color: #555; margin-bottom: 10px; }
    .field-input { padding: 14px 16px; font-size: 15px; border-radius: 6px; color: #888; }
    .field-group { margin-bottom: 24px; }
    .social-half { width: 100% !important; padding-right: 0 !important; max-width: 100% !important; }
    .submit-btn { width: 100%; padding: 16px; font-size: 15px; }
    .upload-desktop { display: none; }
    .upload-mobile { display: flex !important; }
  }
`
export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <title>Zildjian Artist Profile</title>
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}