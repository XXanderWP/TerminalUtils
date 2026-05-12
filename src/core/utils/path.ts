export const DetectApp = () => {
    const args = process.argv.slice(2).map(arg => arg.toLowerCase());
    const isGit = args.includes("git");
    const isSSH = args.includes("ssh");
    const isUpload = args.includes("upload");
    const isNewVersion = args.includes("version");


    if (isGit) {
        return "git";
    }

    if (isSSH) {
        return "ssh";
    }

    if (isUpload) {
        return "upload";
    }

    if (isNewVersion) {
        return "version";
    }

    return 'util';
}