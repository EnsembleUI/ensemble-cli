export const commonParameters = [
  {
    key: 'platform',
    question: 'Which platform(s) are you targeting?',
    type: 'select',
    choices: ['ios', 'android', 'web'],
    platform: ['android', 'ios', 'web'],
  },
  {
    key: 'ensemble_version',
    question: 'Which version of ensemble are you using?',
    type: 'text',
    platform: ['android', 'ios', 'web'],
  },
];

export const scripts = [
  {
    name: 'generateKeystore',
    path: 'scripts/generate_keystore.dart',
    parameters: [],
  },
];
