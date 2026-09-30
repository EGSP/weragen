import { Global, Module } from '@nestjs/common';
import { ModelsController } from './models.controller.js';
import { ModelsService } from './models.service.js';

@Global()
@Module({
    controllers: [ModelsController],
    providers: [ModelsService],
    exports: [ModelsService],
})
export class ModelsModule {}
