for (const name of Object.keys(process.env)) if (name.startsWith('LEARN_APP_DISCORD_')) delete process.env[name];
