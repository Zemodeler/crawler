// Used only against a unique staged application, never the working checkout.
export default {
  appId: "local.studyhub.desktop",
  productName: "Study Hub",
  asar: false,
  npmRebuild: false,
  files: ["package.json", "src/**", "bin/**", "hub/**", "node_modules/**"],
  artifactName: "Study-Hub-${version}-${os}-${arch}.${ext}",
  publish: null,
  win: { target: ["nsis"], signAndEditExecutable: false },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
  mac: { target: ["dmg"], identity: null, notarize: false, category: "public.app-category.education" },
};
