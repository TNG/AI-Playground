const fs = require('fs');
const path = require('path');
const buildDir = path.join(__dirname, '..')

const argv = require('minimist')(process.argv.slice(2));
const onlineInstallerFlag = argv.online_installer
const platform = argv.platform

if (!platform) {
    console.error(`Usage: node render-template.js --platform=$PLATFORM --online_installer (or --no-online_installer)\n`);
    process.exit(1);
}

console.log(onlineInstallerFlag)

// Function to render the template with environment variables
function renderTemplate(templatePath, outputPath, variables) {
    // Read the template content
    fs.readFile(templatePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading template: ${err}`);
            return;
        }

        // Replace placeholders with environment variable values
        let renderedData = data;
        for (const [key, value] of Object.entries(variables)) {
            const placeholder = new RegExp(`\\$\\{${key}\\}`, 'g');
            renderedData = renderedData.replace(placeholder, value);
        }

        // Write the rendered content to the output file
        fs.writeFile(outputPath, renderedData, 'utf8', (err) => {
            if (err) {
                console.error(`Error writing output file: ${err}`);
                return;
            }
            console.log(`Template has been rendered successfully.`);
        });
    });
}

function installerTemplate() {
    if (onlineInstallerFlag) {
        return 'installer.nsh.template'
    } else {
        return 'installer-offline.nsh.template'
    }
}

const templatePath = path.join(buildDir, installerTemplate());
const outputPath = path.join(buildDir, 'installer.nsh');
const variables = {
    PLATFORM: platform
};

renderTemplate(templatePath, outputPath, variables);
