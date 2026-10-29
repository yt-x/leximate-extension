import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'zh_CN',
    // PLAN.md §4.3：默认零主机权限。内容脚本靠 content_scripts.matches 注入，不需要 host_permissions。
    // LLM / 翻译 API / WebDAV 的域名由用户配置（可能是任意自建地址），因此只能走可选权限，且默认不申请。
    permissions: ['storage', 'downloads', 'alarms', 'unlimitedStorage'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // PLAN.md §4.5 P2/P3：内容脚本要按需取词表分片，必须把这些文件暴露出来。
    // 只暴露 dict/ 下的词表——那是本项目自撰、本来就要开源的内容；用户数据一个字节都不在这里。
    web_accessible_resources: [
      {
        resources: ['dict/*.json'],
        matches: ['*://*/*'],
      },
    ],
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
  },
});
