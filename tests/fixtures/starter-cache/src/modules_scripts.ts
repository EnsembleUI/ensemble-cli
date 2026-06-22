export const modules = [
  {
    name: 'camera',
    path: 'scripts/modules/enable_camera.dart',
    parameters: [
      {
        key: 'cameraDescription',
        question: 'Camera description',
        platform: ['ios'],
        type: 'text',
      },
    ],
  },
];
