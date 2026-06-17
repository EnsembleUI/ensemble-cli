export type StarterPlatform = 'ios' | 'android' | 'web';

export interface StarterParameter {
  key: string;
  question: string;
  type: string;
  choices?: string[];
  platform: StarterPlatform[];
}

export interface StarterScript {
  name: string;
  path: string;
  parameters: StarterParameter[];
}

export const STARTER_COMMON_PARAMETERS: StarterParameter[] = [
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
