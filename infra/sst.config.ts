import type { SSTConfig } from 'sst';

export default {
  config(_input) {
    return {
      name: 'bar-ease-hongo',
      region: process.env.AWS_REGION ?? 'ap-northeast-1'
    };
  },
  async stacks(app) {
    const { MenuStack } = await import('./stacks/MenuStack');
    app.stack(MenuStack);
  }
} satisfies SSTConfig;
