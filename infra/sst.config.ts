import { SSTConfig } from 'sst';
import { MenuStack } from './stacks/MenuStack';

export default {
  config(_input) {
    return {
      name: 'bar-ease-hongo',
      region: process.env.AWS_REGION ?? 'ap-northeast-1'
    };
  },
  stacks(app) {
    app.stack(MenuStack);
  }
} satisfies SSTConfig;
