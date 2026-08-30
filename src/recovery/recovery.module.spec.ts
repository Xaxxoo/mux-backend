import { Test } from '@nestjs/testing';
import { RecoveryModule } from './recovery.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

describe('RecoveryModule', () => {
  it('compiles with PrismaModule imported explicitly', async () => {
    const module = await Test.createTestingModule({
      imports: [RecoveryModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(module).toBeDefined();
    expect(module.get(PrismaService)).toBeDefined();
  });

  it('imports PrismaModule in its metadata', () => {
    const imports = Reflect.getMetadata('imports', RecoveryModule) ?? [];
    const hasPrisma = imports.some(
      (m: any) => m === PrismaModule || m?.name === 'PrismaModule',
    );
    expect(hasPrisma).toBe(true);
  });
});
