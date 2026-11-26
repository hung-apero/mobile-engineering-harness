const OPTIONAL_KEYS = ['ads', 'license', 'api'];

const SECRET_FILES = {
  googleServices: 'google-services.json',
  signing: 'signing.properties',
  keystore: 'release.keystore',
  product: 'product-secrets.properties',
};

const secretPath = (key, name) => `$DZ_HOME/secrets/newapp/${key}/${name}`;

function checklist(app) {
  const key = app?.key ?? '<KEY>';
  const file = name => secretPath(key, SECRET_FILES[name]);
  return [
    { id: 'repo-empty', required: true, text: 'Repo GitHub trống, chưa có commit nào (git ls-remote)' },
    { id: 'repo-writable', required: true, text: 'Máy chủ có quyền ghi vào repo GitHub (gh api, chỉ đọc)' },
    { id: 'app-key', required: true, text: 'Mã app viết hoa, bắt đầu bằng chữ, ví dụ AIP396' },
    { id: 'app-package', required: true, text: 'app.package: chữ thường, số, gạch dưới, bắt đầu bằng chữ' },
    { id: 'app-application-id', required: true, text: 'app.applicationId: từ 3 đoạn, ví dụ com.apero.mycoolapp' },
    { id: 'app-name', required: true, text: 'app.name: tên hiển thị trên launcher, tối đa 60 ký tự' },
    { id: 'google-services', required: true, file: file('googleServices'), text: `google-services.json của Firebase, package_name phải khớp applicationId; đặt vào ${file('googleServices')} (quyền 600)` },
    { id: 'firebase-tester-group', required: true, text: 'Tên nhóm tester của Firebase App Distribution' },
    { id: 'signing', required: true, file: file('signing'), text: `Chữ ký release: ${file('signing')} (storeFile, storePassword, keyAlias, keyPassword) và ${file('keystore')} quyền 600; hoặc đồng ý chỉ dùng bản dev (signing: dev-only)` },
    { id: 'jira-project', required: true, text: 'Project Jira mà service đọc được' },
    { id: 'discord-channel', required: true, text: 'ID kênh Discord của app (17-20 chữ số)' },
    { id: 'discord-people', required: true, text: 'ID Discord của PO, QA và dev trực (17-20 chữ số)' },
    { id: 'optional-ads', required: false, file: file('product'), text: `Khoá quảng cáo production trong ${file('product')} (quyền 600); chưa có thì dùng tạm theo started-info.md, thay trước khi lên store` },
    { id: 'optional-license', required: false, file: file('product'), text: `Khoá apero.licenseKey trong ${file('product')} (quyền 600); chưa có thì dùng tạm theo started-info.md, thay trước khi lên store` },
    { id: 'optional-api', required: false, file: file('product'), text: `Khoá chat.api* trong ${file('product')} (quyền 600); chưa có thì dùng tạm theo started-info.md, thay trước khi lên store` },
  ];
}

module.exports = { checklist, OPTIONAL_KEYS, SECRET_FILES };
